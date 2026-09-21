// src/lib/skillNormalization.js
//
// Phase 13 / decision record §7.2–7.2b — the CONTROLLED TAXONOMY resolution
// layer. Pure functions over already-fetched rows; no DB, no I/O, no model
// calls. The decisions this module enforces:
//
//   * §7.2  — a canonical Skill catalogue with synonyms/aliases and tenant
//     extensions. FUZZY FREE-TEXT MATCHING IS NEVER THE SOURCE OF TRUTH: a
//     resolution exists only because a row (SkillAlias or Skill) says so.
//     Everything here is exact-and-case-insensitive over the alias index —
//     deliberately NOT fuzzy. A string that resolves is taxonomy data; a
//     string that does not resolve is UNMAPPED and stays visibly unmapped.
//   * §7.2a — AI may map raw resume/job text to canonical names and SUGGEST
//     synonyms. The suggestion path (recordAliasSuggestion) produces an
//     evidence row, never an auto-accept. The catalogue itself stays
//     deterministic reference data.
//   * §7.2b — platform owns the core (scope PLATFORM, tenantId NULL); tenant
//     HR admins manage approved extensions (scope TENANT). Resolution is
//     tenant-first: a tenant extension wins over the platform core, because
//     the tenant said so most recently and most specifically.
//
// Consumers: candidateMatch.service.js (matching), the reconcile path after a
// parse (mapping AI output onto canonical rows), and the admin alias CRUD.

/** Normalized comparison key: trimmed, lowercased, single-spaced. */
export const aliasKey = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Build the lookup index from alias rows + canonical Skill rows.
 *
 * @param {Array<{alias:string, skillId:number, scope:string, status:string, tenantId:string|null}>} aliasRows
 * @param {Array<{id:number, name:string, tenantId:string|null}>} skills
 * @param {string|null} tenantId - the resolving tenant (null = platform context)
 * @returns {Map<string, number>} key → canonical skillId
 */
export function buildAliasIndex(aliasRows, skills, tenantId) {
    const index = new Map();
    const put = (key, skillId, precedence) => {
        const existing = index.get(key);
        // Later inserts only win on strictly higher precedence: 0 platform
        // alias, 1 platform canonical name, 2 tenant alias, 3 tenant canonical
        // name (most specific wins; first row at a precedence wins ties).
        if (!existing || existing.precedence < precedence) index.set(key, { skillId, precedence });
    };

    for (const row of aliasRows) {
        if (row.status !== "ACTIVE") continue;
        if (row.tenantId && row.tenantId !== tenantId) continue; // another tenant's extension — invisible
        const scope = row.tenantId ? 2 : 0;
        put(aliasKey(row.alias), row.skillId, scope);
    }
    for (const skill of skills) {
        if (skill.tenantId && skill.tenantId !== tenantId) continue;
        put(aliasKey(skill.name), skill.id, skill.tenantId ? 3 : 1);
    }
    return index;
}

function indexGet(index, key) {
    const hit = index.get(key);
    return hit ? hit.skillId : null;
}

/**
 * Resolve one raw name through the index.
 * @returns {{skillId:number}|{skillId:null, unmapped:string}} a resolution or a
 *   visibly-unmapped marker — never a guess.
 */
export function resolveSkill(index, rawName) {
    const key = aliasKey(rawName);
    if (!key) return { skillId: null, unmapped: String(rawName ?? "") };
    const skillId = indexGet(index, key);
    return skillId ? { skillId } : { skillId: null, unmapped: String(rawName) };
}

/**
 * Reconcile an AI parse's raw skill names onto the taxonomy (§7.2a). Returns
 * mapped rows for persistence and UNMAPPED leftovers for the reviewer — the
 * leftovers are evidence, not errors: they feed alias suggestions.
 *
 * @returns {{mapped: Array<{raw, skillId, score, level}>, unmapped: Array<{raw, score, level}>}}
 */
export function reconcileParsedSkills(index, parsedItems) {
    const mapped = [];
    const unmapped = [];
    for (const item of parsedItems ?? []) {
        const raw = String(item?.name ?? "").trim();
        if (!raw) continue;
        const res = resolveSkill(index, raw);
        if (res.skillId) {
            mapped.push({ raw, skillId: res.skillId, score: item?.score ?? null, level: item?.level ?? null });
        } else {
            unmapped.push({ raw, score: item?.score ?? null, level: item?.level ?? null });
        }
    }
    return { mapped, unmapped };
}

/**
 * §7.2a — build the evidence row for an AI-suggested alias. The caller decides
 * whether to persist it; it lands with origin 'ai-suggested' and, per §7.2a,
 * becomes a resolution only after an authorized admin accepts it. There is no
 * auto-accept path in this module by design.
 */
export function recordAliasSuggestion({ alias, skillId, tenantId }) {
    return {
        alias: String(alias ?? "").trim(),
        skillId,
        scope: tenantId ? "TENANT" : "PLATFORM",
        origin: "ai-suggested",
        status: "ACTIVE", // active as evidence; it is a RESOLUTION only because a row exists
        tenantId: tenantId ?? null,
    };
}

/**
 * Taxonomy-anchored matching (§7.2 + the §7 canonical chain). Both sides are
 * resolved canonical ids BEFORE any comparison — never raw strings — so an
 * alias ("JS", "Javascript", "java script") and its canonical ("JavaScript")
 * are the same fact.
 *
 * @param {Array<{name, score?, level?}>} candidateSkills raw candidate items
 * @param {{required: string[], preferred: string[]}} requisitionReq raw requirement names
 * @returns an ADVISORY match report; contains no decision and no ranking verb
 */
export function matchCandidateToRequisition(index, candidateSkills, requisitionReq) {
    const candidateResolved = (candidateSkills ?? [])
        .map((s) => ({ ...s, res: resolveSkill(index, s?.name) }))
        .filter((s) => s.res.skillId);
    const candidateIds = new Set(candidateResolved.map((s) => s.res.skillId));

    const resolveReq = (names, importance) =>
        (names ?? [])
            .map((n) => String(n ?? "").trim())
            .filter(Boolean)
            .map((raw) => {
                const res = resolveSkill(index, raw);
                return {
                    raw,
                    importance,
                    skillId: res.skillId,
                    // A requirement that resolves nowhere is reported as such —
                    // the taxonomy gap is the actionable fact, not a fake miss.
                    unmapped: res.skillId ? null : raw,
                };
            });

    const required = resolveReq(requisitionReq?.required, "required");
    const preferred = resolveReq(requisitionReq?.preferred, "preferred");

    const matched = [];
    const missing = [];
    for (const req of [...required, ...preferred]) {
        if (req.skillId && candidateIds.has(req.skillId)) {
            const hit = candidateResolved.find((s) => s.res.skillId === req.skillId);
            matched.push({ skillId: req.skillId, canonical: true, importance: req.importance, score: hit?.score ?? null, level: hit?.level ?? null });
        } else {
            missing.push({ raw: req.unmapped ?? null, skillId: req.skillId ?? null, importance: req.importance });
        }
    }

    return {
        matched,
        missing,
        // Unmapped candidate items surface for curation (alias suggestions),
        // keeping the loop of §7.2a: AI suggests, humans curate.
        unmappedCandidateSkills: (candidateSkills ?? [])
            .map((s) => String(s?.name ?? "").trim())
            .filter((n) => n && !resolveSkill(index, n).skillId),
        // §7.3 — advisory evidence only. There is no overall score field: a
        // single number invites ranking, ranking invites automation, and AI
        // ranking must not become the presumed decision-maker.
        coverage: {
            requiredTotal: required.length,
            requiredMatched: required.filter((r) => r.skillId && candidateIds.has(r.skillId)).length,
            preferredTotal: preferred.length,
            preferredMatched: preferred.filter((r) => r.skillId && candidateIds.has(r.skillId)).length,
        },
    };
}

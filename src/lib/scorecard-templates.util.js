// src/lib/scorecard-templates.util.js
//
// Phase 7 / decision record §5.5–5.5b — the PURE template rules.
//
// No DB, no I/O. The service stores templates and resolves links; THIS module
// owns the decisions so the write path, the tools and any future reporting
// surface cannot drift:
//
//   * §5.5a — weights are OPTIONAL per criterion and EQUAL weighting is the
//     default. The weighted overall is computed only when at least one weight
//     actually differs from the others; a template that never sets weights
//     behaves exactly like the plain average that existed before templates.
//   * §5.5b — each criterion is required/optional; a submission missing any
//     required criterion refuses (the list of missing keys travels in the
//     error details, so the reviewer's UI can underline the gaps).
//   * §5.5c — locking is NOT here. A submitted scorecard already locks through
//     the Phase 3.4 amendment path; a template never rewrites history.
//
// Template resolution is MOST-SPECIFIC-FIRST:
//     REQUISITION → STAGE → JOB_FAMILY → (tenant default = most-recent active
//     template with no REQUISITION/STAGE link? No — a default is just the
//     JOB_FAMILY/STAGE-less lookup falling through to any active template the
//     tenant linked broadly; if nothing matches, scores are free-form as
//     before). Falling through to free-form is deliberate: a tenant that never
//     configures templates must not find its existing interview flow broken.

/** The link scope vocabulary (mirrors the migration's CHECK). */
export const TEMPLATE_SCOPES = ["REQUISITION", "STAGE", "JOB_FAMILY"];

/**
 * Phase 3b — the evaluation-form scopes (flag evaluationForms). INTERVIEW_TYPE
 * and PANEL_ROLE are vocabulary keys carried in scopeKey, like STAGE.
 */
export const FORM_TEMPLATE_SCOPES = [...TEMPLATE_SCOPES, "INTERVIEW_TYPE", "PANEL_ROLE"];
export const KEYED_SCOPES = ["STAGE", "INTERVIEW_TYPE", "PANEL_ROLE"];

/**
 * Validate a criteria list. Ordered, non-empty, unique keys; optional numeric
 * weight > 0; required defaults to true? No — §5.5b says each criterion IS
 * required/optional, and the safer default for evidence is REQUIRED: a tenant
 * that forgets to mark a criterion gets an enforced one, not a skippable one.
 * Label defaults to the key when omitted.
 *
 * @returns {{ ok: true, criteria: object[] } | { ok: false, error: string }}
 */
export function validateCriteria(criteria) {
    if (!Array.isArray(criteria) || criteria.length === 0) {
        return { ok: false, error: "A template needs at least one criterion" };
    }
    // NB: this validates a TEMPLATE's criteria (key/label/weight/required/numeric),
    // not a submitted scorecard — see validateScreeningAgainstTemplate for that.
    const seen = new Set();
    const out = [];
    for (const [i, raw] of criteria.entries()) {
        const key = typeof raw?.key === "string" ? raw.key.trim() : "";
        if (!key) return { ok: false, error: `Criterion ${i + 1}: key is required` };
        if (seen.has(key)) return { ok: false, error: `Duplicate criterion key "${key}"` };
        seen.add(key);

        const weight = raw.weight === undefined || raw.weight === null ? null : Number(raw.weight);
        if (weight !== null && (!Number.isFinite(weight) || weight <= 0)) {
            return { ok: false, error: `Criterion "${key}": weight must be a positive number` };
        }

        out.push({
            key,
            label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : key,
            weight,
            required: raw.required === undefined ? true : raw.required === true,
            // FR-07 residue — a criterion may declare itself NUMERIC, which makes
            // a numeric score mandatory at submission time. Additive + optional:
            // a template that never sets it behaves exactly as before.
            numeric: raw.numeric === true,
        });
    }

    // §5.5a — weights are all-or-none meaningful: if ANY weight is set, they
    // must all be set, otherwise the weighted overall would silently mix
    // declared importance with an implicit 1.
    const weighted = out.filter((c) => c.weight !== null);
    if (weighted.length > 0 && weighted.length !== out.length) {
        return { ok: false, error: "Weights must be set on every criterion, or on none (equal weighting)" };
    }
    return { ok: true, criteria: out };
}

/** Does this template use weighted scoring at all (§5.5a)? */
export function isWeighted(criteria = []) {
    return criteria.length > 0 && criteria.every((c) => typeof c.weight === "number" && c.weight > 0);
}

/**
 * The overall score for a submission against a template.
 *
 * Equal weighting (default): the plain average of the submitted values —
 * identical to the pre-template behaviour. Weighted: sum(value × weight) /
 * sum(weight), over the criteria that were actually submitted; optional
 * criteria left blank drop out of BOTH numerator and denominator, so an
 * unanswered optional criterion does not drag the score down.
 *
 * @param {object[]} criteria  the template's criteria
 * @param {object} scores      { [criterionKey]: number }
 * @returns {{ overall: number|null, weighted: boolean }}
 */
export function computeOverall(criteria = [], scores = {}) {
    const weighted = isWeighted(criteria);
    let num = 0;
    let den = 0;
    for (const c of criteria) {
        const v = scores?.[c.key];
        if (v === undefined || v === null || v === "") continue;
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        num += weighted ? n * c.weight : n;
        den += weighted ? c.weight : 1;
    }
    if (den === 0) return { overall: null, weighted };
    const overall = weighted ? num / den : num / den;
    return { overall, weighted };
}

/**
 * §5.5b — which REQUIRED criteria did the submission miss? Optional criteria
 * left blank are fine. Unknown keys (submitted but not in the template) are
 * reported separately so a typo'd key surfaces instead of vanishing.
 *
 * @returns {{ missing: string[], unknown: string[] }}
 */
export function checkRequiredCriteria(criteria = [], scores = {}) {
    const missing = [];
    const unknown = [];
    const known = new Set(criteria.map((c) => c.key));
    for (const c of criteria) {
        const v = scores?.[c.key];
        if (c.required && (v === undefined || v === null || v === "")) missing.push(c.key);
    }
    for (const k of Object.keys(scores ?? {})) {
        if (!known.has(k)) unknown.push(k);
    }
    return { missing, unknown };
}

/**
 * §5.5 — pick the template for an interview, MOST-SPECIFIC-FIRST:
 * REQUISITION → STAGE → JOB_FAMILY. The caller passes the already-fetched
 * candidate link rows (active, tenant-scoped, template included); the ORDER
 * lives here so every surface resolves identically. Ties (two links of the
 * same scope) resolve to the lowest template id — deterministic, stable.
 *
 * @param {{ scopeType: string, scopeId: number|null, scopeKey: string|null,
 *            template: object }[]} links
 * @param {{ jobRequisitionId: number|null, positionId: number|null, interviewType: string|null }} ctx
 * @returns {object|null} the winning template, or null (→ free-form scoring)
 */
/**
 * FR-07 residue — validate a SCREENING record's criteria against the template
 * that resolves for its requisition, when one does.
 *
 * A screening entry is `{ criterion, result, score? }` where `criterion` is the
 * template KEY (that is what makes the two linkable). Rules, in order:
 *   * every REQUIRED template criterion must be present (by key)
 *   * a numeric score is REQUIRED when the template marks the criterion numeric
 *     (`numeric: true`) — the "template requires them" half of the residue;
 *     a numeric score on a non-numeric criterion is allowed but not demanded
 *   * unknown keys are reported, never silently dropped (same rule as §5.5b)
 *   * the overall is computed with the SAME math the interview scorecard uses,
 *     so a screening score and an interview score are comparable
 *
 * @returns {{ ok: boolean, errors: string[], missing: string[], unknown: string[],
 *             overall: number|null, weighted: boolean }}
 */
export function validateScreeningAgainstTemplate({ criteria = [], templateCriteria = [] } = {}) {
    const errors = [];
    const byKey = new Map();
    for (const entry of criteria) {
        const key = typeof entry?.criterion === "string" ? entry.criterion.trim() : "";
        if (key) byKey.set(key, entry);
    }

    const known = new Set(templateCriteria.map((c) => c.key));
    const missing = templateCriteria
        .filter((c) => c.required && !byKey.has(c.key))
        .map((c) => c.key);
    if (missing.length) errors.push(`missing required criteria: ${missing.join(", ")}`);

    const scores = {};
    for (const c of templateCriteria) {
        const entry = byKey.get(c.key);
        if (!entry) continue;
        const hasScore = entry.score !== undefined && entry.score !== null;
        if (c.numeric === true && !hasScore) {
            errors.push(`criterion "${c.key}" requires a numeric score`);
        }
        if (hasScore) scores[c.key] = entry.score;
    }

    const unknown = [...byKey.keys()].filter((k) => !known.has(k));
    const { overall, weighted } = computeOverall(templateCriteria, scores);
    return { ok: errors.length === 0, errors, missing, unknown, overall, weighted };
}

/**
 * §5.5 — the template lookup shared by every surface that resolves one
 * (interview scorecard, screening scorecard). The ORDER lives in
 * `resolveTemplate`; this is the fetch.
 *
 * @returns {Promise<object|null>} the winning template WITH its criteria, or null
 */
export function resolveTemplate(links = [], ctx = {}) {
    // Phase 3b — a template that declares an interview type or a panel role
    // applies only there; within a rung the one matching the panel role, then
    // the interview type, wins before the lowest id. Templates from before
    // forms declare neither, so for them this is the plain lowest-id rule.
    const applies = (t) =>
        (!t.interviewType || !ctx.interviewType || t.interviewType === ctx.interviewType) &&
        (!t.panelRole || !ctx.panelRole || t.panelRole === ctx.panelRole);
    const specificity = (t) =>
        (ctx.panelRole && t.panelRole === ctx.panelRole ? 2 : 0) + (ctx.interviewType && t.interviewType === ctx.interviewType ? 1 : 0);
    const pick = (match) => {
        const hits = links
            .filter((l) => match(l) && applies(l.template))
            .sort((a, b) => specificity(b.template) - specificity(a.template) || a.template.id - b.template.id);
        return hits[0]?.template ?? null;
    };
    const keyed = (scopeType, value) => (l) => l.scopeType === scopeType && value != null && l.scopeKey === value;

    return (
        pick((l) => l.scopeType === "REQUISITION" && l.scopeId === ctx.jobRequisitionId) ??
        // Phase 3b — interview type and panel role: a template linked by both
        // beats one linked by either.
        pickBoth(links, ctx, applies) ??
        pick(keyed("INTERVIEW_TYPE", ctx.interviewType)) ??
        pick(keyed("PANEL_ROLE", ctx.panelRole)) ??
        // STAGE has always been keyed by the interview type; the application's
        // stage matches too, so existing STAGE links keep resolving.
        pick((l) => l.scopeType === "STAGE" && (l.scopeKey === ctx.interviewType || (ctx.stage != null && l.scopeKey === ctx.stage))) ??
        pick((l) => l.scopeType === "JOB_FAMILY" && l.scopeId === ctx.positionId) ??
        null
    );
}

/** A template linked to BOTH the interview type and the panel role. */
function pickBoth(links, ctx, applies) {
    if (!ctx.interviewType || !ctx.panelRole) return null;
    const byType = new Set(
        links.filter((l) => l.scopeType === "INTERVIEW_TYPE" && l.scopeKey === ctx.interviewType).map((l) => l.template.id),
    );
    const hits = links
        .filter((l) => l.scopeType === "PANEL_ROLE" && l.scopeKey === ctx.panelRole && byType.has(l.template.id) && applies(l.template))
        .sort((a, b) => a.template.id - b.template.id);
    return hits[0]?.template ?? null;
}

/**
 * Phase 3b — versions share a templateKey and a link points at one version
 * row. Resolution follows a link to the latest PUBLISHED version of its key,
 * so publishing a new version never needs relinking; a template without a key
 * (Phase 7) is its own only version.
 *
 * @param {object} template      the linked row
 * @param {object[]} published   PUBLISHED, active rows sharing keys
 */
export function latestPublishedVersion(template, published = []) {
    if (!template?.templateKey) return template;
    const versions = published.filter((t) => t.templateKey === template.templateKey);
    if (!versions.length) return null;
    return versions.reduce((best, t) => (Number(t.version) > Number(best.version) ? t : best));
}

// src/services/candidateMatch.service.js
//
// Phase 13 / decision record §7.2a–7.3b — the ADVISORY candidate↔requisition
// match. The canonical chain this service implements:
//
//   candidate evidence → AI advisory analysis → human review → human decision
//
// What that means in code, line by line:
//   * §7.1    every model call goes through lib/aiPlaneClient.js (the plane owns
//             provider, PII redaction §7.1a and residency eligibility §7.1b).
//   * §7.2    matching is TAXONOMY-ANCHORED: both sides resolve to canonical
//             Skill ids through the alias index before any comparison; the AI
//             output only ADDS evidence (a summary), never substitutes the
//             deterministic comparison.
//   * §7.3    NOTHING here advances, rejects, offers or hires. The service
//             writes no Application-state change — it reads candidates and
//             requisitions, records provenance (§7.4) and returns evidence.
//   * §7.3a   the report carries no decision and no required-justification
//             field. A recruiter disagreeing with it needs no reason; the AI
//             output is advisory evidence, not a presumed decision.
//   * §7.3b   visibility is enforced by the CALLERS (REST route authorization
//             + the MCP gateway): recruiter and appropriately-authorized
//             hiring manager only. Interviewer surfaces never call this, so a
//             pre-scorecard candidate cannot see fit/ranking anchoring. (The
//             report deliberately has NO ranking or overall score to leak.)
//   * §7.4    every inference writes an AiInferenceRecord row — ok, error,
//             pending or degraded-unavailable — with input hash, prompt key,
//             provider/model, trace id and the candidate/requisition link.
//   * §7.4a   candidate-linked rows ride the candidate's retention/erasure
//             policy (the FK is ON DELETE CASCADE).
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import logger from "../lib/logger.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { runAiTask } from "../lib/aiPlaneClient.js";
import { buildAliasIndex, matchCandidateToRequisition, resolveSkill } from "../lib/skillNormalization.js";
import { createHash } from "node:crypto";

const PROMPT_KEY = "hr.match.score.v1";
const OUTPUT_SCHEMA_V = 1;

/**
 * Load the alias index for one tenant: platform core + that tenant's
 * extensions (§7.2b). Cheap; callers may cache upstream.
 */
export async function loadAliasIndex(tenantId) {
    const [aliasRows, skills] = await Promise.all([
        prisma.skillAlias.findMany({
            where: { OR: [{ tenantId: null }, { tenantId }], status: "ACTIVE" },
            select: { alias: true, skillId: true, scope: true, status: true, tenantId: true },
        }),
        prisma.skill.findMany({
            where: { OR: [{ tenantId: null }, { tenantId }] },
            select: { id: true, name: true, tenantId: true },
        }),
    ]);
    return buildAliasIndex(aliasRows, skills, tenantId ?? null);
}

/**
 * Build the advisory match report for one candidate against one requisition.
 *
 * @param {object} opts
 * @param {number} opts.candidateId
 * @param {number} opts.requisitionId
 * @param {string|null} opts.tenantId
 * @param {boolean} [opts.withAiSummary] - request the plane's advisory summary
 *   (optional: the deterministic taxonomy report stands alone without it)
 * @param {string|null} [opts.actorId] - provenance trace attribution
 */
export async function matchCandidateToRequisitionAdvisory({ candidateId, requisitionId, tenantId = null, withAiSummary = false, actorId = null }) {
    // D-13 — both reads are tenant-scoped: a foreign tenant's candidate or
    // requisition reads as not-found rather than being matched.
    if (!tenantId) throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
    const candidate = await prisma.candidate.findFirst({
        where: scopedWhere(tenantId, { id: Number(candidateId) }),
        select: {
            id: true,
            firstName: true,
            lastName: true,
            parsedResume: true,
            tenantId: true,
            candidateSkills: { select: { name: true, score: true, level: true, category: true } },
        },
    });
    if (!candidate) throw Object.assign(new Error("Candidate not found"), { status: 404 });

    const requisition = await prisma.jobRequisition.findFirst({
        where: scopedWhere(tenantId, { id: Number(requisitionId) }),
        select: { id: true, title: true, jobContent: true, requirements: true, tenantId: true },
    });
    if (!requisition) throw Object.assign(new Error("Requisition not found"), { status: 404 });

    const index = await loadAliasIndex(tenantId);

    // Candidate evidence: parsed resume skills + any hand-entered ones.
    const candidateItems = [
        ...(Array.isArray(candidate.parsedResume?.skills) ? candidate.parsedResume.skills : []),
        ...(candidate.candidateSkills ?? []),
    ];

    // Requisition evidence: structured job content first (§ decision 1.3), the
    // legacy free-text requirements field as fallback source of skill names.
    const reqSkills = requisitionSkillRequirements(requisition);

    // 1. Deterministic, taxonomy-anchored comparison — runs ALWAYS.
    const report = matchCandidateToRequisition(index, candidateItems, reqSkills);

    // 2. Optional AI advisory summary (§7.2a: AI adds analysis, not decisions).
    // Phase 15 — gated by HR_RECRUITMENT_AI (§7.1b: no approved config → AI off).
    let ai = null;
    if (withAiSummary && !isRecruitmentFlagEnabled("ai")) {
        ai = { unavailable: true, reason: "flag-disabled" };
    } else if (withAiSummary) {
        ai = await aiSummary({
            requisition,
            candidateItems,
            tenantId: tenantId ?? candidate.tenantId ?? null,
            candidateId: candidate.id,
            requisitionId: requisition.id,
            actorId,
        });
    }

    return {
        advisory: true, // §7.3 — explicit marker; consumers must not treat this as a decision
        candidate: { id: candidate.id, name: `${candidate.firstName} ${candidate.lastName ?? ""}`.trim() },
        requisition: { id: requisition.id, title: requisition.title },
        taxonomy: report,
        ai,
    };
}

/**
 * The optional AI layer. Failure-degrades: if the plane is unavailable the
 * deterministic report still returns, with the degraded inference recorded
 * (§7.4: a degraded attempt is provenance too).
 */
async function aiSummary({ requisition, candidateItems, tenantId, candidateId, requisitionId, actorId }) {
    const jobContentText = summarizeJobContent(requisition);
    const candidateProfileText = (candidateItems ?? [])
        .map((s) => `${s.name}${s.level ? ` (${s.level})` : ""}`)
        .join("; ");
    const inputHash = createHash("sha256").update(`${requisition.id}:${candidateProfileText}`).digest("hex");

    let res;
    try {
        res = await runAiTask({
            promptKey: PROMPT_KEY,
            type: "hr.candidate-match",
            tenantId,
            input: { jobContent: jobContentText, candidateProfile: candidateProfileText },
            correlationId: `match:${requisitionId}:${candidateId}`,
        });
    } catch (err) {
        await recordInference({
            kind: "candidate-match",
            promptKey: PROMPT_KEY,
            inputHash,
            status: "degraded-unavailable",
            errorMessage: `${err?.code ?? ""} ${err?.message ?? err}`.trim().slice(0, 500),
            tenantId,
            candidateId,
            requisitionId,
        });
        return { unavailable: true, reason: err?.code ?? "HR-AI-PLANE-UNAVAILABLE" };
    }

    const output = res?.output ?? {};
    const base = {
        promptKey: PROMPT_KEY,
        outputSchemaV: OUTPUT_SCHEMA_V,
        provider: output.provider ?? null,
        model: output.model ?? null,
        tokensUsed: res.tokensUsed ?? null,
        taskId: res.taskId,
    };

    if (res.status !== "ok" || res.error) {
        await recordInference({
            kind: "candidate-match",
            promptKey: PROMPT_KEY,
            provider: base.provider,
            model: base.model,
            inputHash,
            status: res.status === "pending" ? "pending" : "error",
            errorMessage: String(res.error ?? "plane returned non-ok status").slice(0, 500),
            tokensUsed: res.tokensUsed ?? null,
            traceId: res.taskId,
            tenantId,
            candidateId,
            requisitionId,
        });
        return { ...base, unavailable: true, status: res.status, error: res.error ?? "non-ok status" };
    }

    const parsed = output?.result && typeof output.result === "object" ? output.result : {};
    await recordInference({
        kind: "candidate-match",
        promptKey: PROMPT_KEY,
        provider: base.provider,
        model: base.model,
        inputHash,
        outputSchemaV: OUTPUT_SCHEMA_V,
        status: "ok",
        // Confidence where meaningful (§7.4): the model's own self-report, if any.
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
        tokensUsed: res.tokensUsed ?? null,
        traceId: res.taskId,
        tenantId,
        candidateId,
        requisitionId,
    });

    // §7.2a — AI-mapped skill names are resolved through the SAME taxonomy
    // index; anything it names that resolves becomes canonical evidence,
    // anything else is reported as unmapped, never silently trusted.
    const index = await loadAliasIndex(tenantId);
    const resolveList = (list) =>
        (Array.isArray(list) ? list : [])
            .map((item) => {
                const name = typeof item === "string" ? item : item?.name;
                if (!name) return null;
                const r = resolveSkill(index, name);
                return { name, skillId: r.skillId, unmapped: r.skillId ? false : true };
            })
            .filter(Boolean);

    return {
        ...base,
        summary: typeof parsed.summary === "string" ? parsed.summary : null,
        matchedSkills: resolveList(parsed.matchedSkills),
        missingSkills: resolveList(parsed.missingSkills),
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    };
}

async function recordInference(data) {
    try {
        await prisma.aiInferenceRecord.create({ data });
    } catch (err) {
        logger.warn({ err: err?.message }, "candidate-match: ai_inference_records write failed (best-effort)");
    }
}

// ---- requisition skill extraction (deterministic, no AI) -------------------
//
// jobContent.skills is what normalizeJobContent (lib/requisitionFields.js)
// stores: a flat string[]. Importance therefore travels IN the string, as a
// marker a recruiter types ("React (preferred)", "Nice to have: GraphQL").
// Older or hand-written rows may still carry {name, importance} objects or a
// {required, preferred} block. All three shapes are read here; a skill with
// no marker is required, which is what a flat list always meant.

// Importance values (object entries) and markers (string entries) that make
// a skill preferred rather than required. Compared lowercased, with
// "-"/"_" read as spaces.
const PREFERRED_IMPORTANCE = new Set(["preferred", "nice to have", "optional", "desired", "bonus", "plus"]);
const PREFERRED_MARKER = "(?:preferred|nice[\\s_-]*to[\\s_-]*have|optional|desired|bonus|a plus)";
const PREFERRED_SUFFIX = new RegExp(`\\s*[([]\\s*${PREFERRED_MARKER}\\s*[)\\]]\\s*$`, "i");
const PREFERRED_PREFIX = new RegExp(`^\\s*${PREFERRED_MARKER}\\s*[:\\-–]\\s*`, "i");

const isPreferredImportance = (value) =>
    PREFERRED_IMPORTANCE.has(String(value ?? "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " "));

/** One skills[] entry → { name, importance }, reading the marker off a string. */
function classifySkillEntry(entry) {
    if (typeof entry === "string") {
        const raw = entry.trim();
        const stripped = raw.replace(PREFERRED_SUFFIX, "").replace(PREFERRED_PREFIX, "").trim();
        return { name: stripped || null, importance: stripped !== raw ? "preferred" : "required" };
    }
    if (entry && typeof entry === "object") {
        const name = typeof entry.name === "string" ? entry.name.trim() : null;
        const preferred = isPreferredImportance(entry.importance ?? entry.priority) || entry.required === false;
        return { name: name || null, importance: preferred ? "preferred" : "required" };
    }
    return { name: null, importance: "required" };
}

function extractRequisitionSkills(jobContent) {
    if (!jobContent || typeof jobContent !== "object") return null;
    const skillsBlock = jobContent.skills ?? jobContent.Skills;
    let required = [];
    let preferred = [];
    if (Array.isArray(skillsBlock)) {
        // Strings (with an optional preferred marker) or {name, importance}.
        // The importance used to be computed and then ignored, so every
        // preferred skill was counted as required.
        for (const entry of skillsBlock) {
            const { name, importance } = classifySkillEntry(entry);
            if (!name) continue;
            (importance === "preferred" ? preferred : required).push(name);
        }
    } else if (skillsBlock && typeof skillsBlock === "object") {
        const names = (list) => (Array.isArray(list) ? list : []).map((s) => classifySkillEntry(s).name).filter(Boolean);
        required = names(skillsBlock.required);
        preferred = [
            ...names(skillsBlock.preferred),
            ...names(skillsBlock.niceToHave ?? skillsBlock.nice_to_have),
            ...names(skillsBlock.optional),
        ];
    }
    if (!required.length && !preferred.length) return null;
    return { required, preferred };
}

/**
 * The requisition's skill requirements as { required: string[], preferred:
 * string[] }: structured job content first, the legacy free-text
 * requirements as the fallback, null when neither names a skill. Shared with
 * the fit score (application-scoring.service.js) so both read one rule.
 */
export function requisitionSkillRequirements(requisition) {
    if (!requisition) return null;
    return extractRequisitionSkills(requisition.jobContent) ?? extractFromLegacyRequirements(requisition.requirements);
}

function extractFromLegacyRequirements(requirements) {
    if (!requirements || typeof requirements !== "string") return null;
    // Legacy free text: take the whole blob as `required` names by splitting on
    // separators. Deliberately conservative — this is a fallback for requisitions
    // that predate structured job content, and unmapped items surface visibly.
    const names = requirements
        .split(/[,;\n•\u2022]+/)
        .map((s) => s.replace(/^[-*\d.)\s]+/, "").trim())
        .filter((s) => s.length > 1 && s.length < 60);
    if (!names.length) return null;
    return { required: names.slice(0, 20), preferred: [] };
}

function summarizeJobContent(requisition) {
    if (requisition.jobContent && typeof requisition.jobContent === "object") {
        const jc = requisition.jobContent;
        return JSON.stringify({
            summary: jc.summary ?? null,
            responsibilities: jc.responsibilities ?? null,
            requirements: jc.requirements ?? null,
            skills: jc.skills ?? null,
        });
    }
    return requisition.requirements ?? "";
}

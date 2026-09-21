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
import logger from "../lib/logger.js";
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
    const candidate = await prisma.candidate.findUnique({
        where: { id: Number(candidateId) },
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

    const requisition = await prisma.jobRequisition.findUnique({
        where: { id: Number(requisitionId) },
        select: { id: true, title: true, jobContent: true, requirements: true, tenantId: true },
    });
    if (!requisition) throw Object.assign(new Error("Requisition not found"), { status: 404 });

    const index = await loadAliasIndex(tenantId ?? candidate.tenantId ?? requisition.tenantId ?? null);

    // Candidate evidence: parsed resume skills + any hand-entered ones.
    const candidateItems = [
        ...(Array.isArray(candidate.parsedResume?.skills) ? candidate.parsedResume.skills : []),
        ...(candidate.candidateSkills ?? []),
    ];

    // Requisition evidence: structured job content first (§ decision 1.3), the
    // legacy free-text requirements field as fallback source of skill names.
    const reqSkills = extractRequisitionSkills(requisition.jobContent) ?? extractFromLegacyRequirements(requisition.requirements);

    // 1. Deterministic, taxonomy-anchored comparison — runs ALWAYS.
    const report = matchCandidateToRequisition(index, candidateItems, reqSkills);

    // 2. Optional AI advisory summary (§7.2a: AI adds analysis, not decisions).
    let ai = null;
    if (withAiSummary) {
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

function extractRequisitionSkills(jobContent) {
    if (!jobContent || typeof jobContent !== "object") return null;
    const skillsBlock = jobContent.skills ?? jobContent.Skills;
    let required = [];
    let preferred = [];
    if (Array.isArray(skillsBlock)) {
        // [{name, importance}] or flat string list (all required).
        required = skillsBlock
            .map((s) => {
                const name = typeof s === "string" ? s : s?.name;
                const importance = (typeof s === "object" && s?.importance) || "required";
                return { name, importance };
            })
            .filter((s) => s.name);
    } else if (skillsBlock && typeof skillsBlock === "object") {
        required = (skillsBlock.required ?? []).map((name) => ({ name, importance: "required" }));
        preferred = (skillsBlock.preferred ?? []).map((name) => ({ name, importance: "preferred" }));
    }
    if (!required.length && !preferred.length) return null;
    return {
        required: required.map((s) => s.name),
        preferred: preferred.map((s) => s.name),
    };
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

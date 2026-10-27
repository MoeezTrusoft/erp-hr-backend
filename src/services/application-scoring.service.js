// src/services/application-scoring.service.js
//
// Recruitment Phase 2 (§6.4) — fit score, requisition ranking and shortlist
// PROPOSALS. "Compute a numeric fit score from taxonomy coverage, experience
// years and knockout results; store it with its model version; rank the
// requisition's applications; flag the top share for the shortlist. The
// recruiter confirms the shortlist."
//
// Three rules shape this file:
//
//   * FEATURES. The score reads only the columns in the SCORING_* selects
//     below: requisition skills (and the legacy requirements text the skill
//     extraction falls back to), the candidate's skill names and parsed years
//     of experience, and the application's answer total and knockout flag.
//     No name, email, gender, age, date of birth, nationality, photo, address
//     or free text is selected, so none can become a feature by accident.
//     buildFitInputs then hands computeFitScore exactly its eight inputs.
//   * A PROPOSAL IS NOT A DECISION. The proposal step writes a ShortlistEntry
//     with source SCORING_PROPOSAL and no addedById; only a recruiter (or the
//     requisition's hiring manager) confirming it turns it into a MANUAL entry
//     with their id, and dismissing it deletes it. ApplicationScore
//     .shortlistProposedAt records that an application was proposed, so it is
//     never proposed a second time, even after a dismissal. A recruiter's
//     MANUAL entry is never touched here.
//   * TENANCY. Reads apply withTenant explicitly on top of RLS; writes run in
//     tenantTransaction. The job scans tenants under the system context and
//     scores each tenant under that tenant's own context.
//
// Visibility (§7.3b): the score and the ranking are recruiter and hiring
// manager material. ORG reads every requisition, MANAGED only its own;
// interviewer, finance and agency scopes read NOT FOUND, so an interviewer is
// never anchored by a fit score before their scorecard.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { eventContext } from "../lib/event-context.util.js";
import {
    RECRUITMENT_SCOPE,
    applicationScopeWhere,
    maskCandidateForScope,
    requisitionScopeWhere,
} from "../lib/recruitment-access.util.js";
import { computeFitScore, componentsAssessed, FIT_MODEL_VERSION } from "../lib/fit-score.util.js";
import { logAction } from "../utils/logs.js";
import { loadAliasIndex, requisitionSkillRequirements } from "./candidate-match.service.js";
import { getRecruitmentSettings } from "./recruitment-settings.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";

const scoringLog = logger.child({ component: "application-scoring" });

export const SHORTLIST_PROPOSED_EVENT = "hr.recruitment.shortlist_proposed.v1";
export const SHORTLIST_SOURCE = Object.freeze({ MANUAL: "MANUAL", PROPOSAL: "SCORING_PROPOSAL" });

// Stages that end an application: never scored by the job, never ranked,
// never proposed.
export const INACTIVE_STAGES = Object.freeze(["hired", "rejected", "withdrawn"]);

// Requisitions still hiring; a proposal on a closed one would be noise.
const PROPOSABLE_REQUISITION_STATUSES = Object.freeze(["APPROVED", "POSTED"]);

// Ranking order: score, then the earlier application, then id for a total order.
const RANK_ORDER = Object.freeze([{ score: "desc" }, { application: { appliedAt: "asc" } }, { applicationId: "asc" }]);

const DEFAULT_JOB_LIMIT = 200;
const MAX_PAGE_SIZE = 100;

// parsedResume is free-form parser output; years of experience has appeared
// under these keys (the same probe candidate-pipeline.service.js uses).
const CANDIDATE_YEARS_KEYS = Object.freeze(["yearsOfExperience", "totalExperience", "experienceYears"]);
// The requisition's minimum, when its job content carries one.
const REQUISITION_MIN_YEARS_KEYS = Object.freeze(["minYearsExperience", "minExperienceYears"]);

// ── The feature columns (the only data the score can read) ──────────────────
export const SCORING_CANDIDATE_SELECT = Object.freeze({
    id: true,
    parsedResume: true, // read for years of experience only (see buildFitInputs)
    candidateSkills: { select: { name: true } },
});
export const SCORING_REQUISITION_SELECT = Object.freeze({
    id: true,
    jobContent: true, // skills[] and the minimum years
    requirements: true, // legacy skill list fallback
});
export const SCORING_APPLICATION_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    candidateId: true,
    jobRequisitionId: true,
    stage: true,
    knockedOut: true,
    answerScore: true,
    answerMaxScore: true,
    candidate: { select: SCORING_CANDIDATE_SELECT },
    jobRequisition: { select: SCORING_REQUISITION_SELECT },
});

const fail = (message, code, status) => Object.assign(new Error(message), { status, code });

const notFound = (what = "Application") =>
    fail(`${what} not found`, `HR-RECRUITMENT-${what.toUpperCase().replace(/\s+/g, "-")}-NOT-FOUND`, 404);

/** 503 when the scoring flag is off (tools call this first). */
export function assertScoringEnabled() {
    if (!isRecruitmentFlagEnabled("scoring")) {
        throw fail("Application scoring is disabled", "HR-RECRUITMENT-SCORING-DISABLED", 503);
    }
}

const firstNumber = (source, keys) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;
    for (const key of keys) {
        const raw = source[key];
        if (raw === undefined || raw === null || raw === "") continue;
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
};

/**
 * The fit-score inputs for one application row (selected with
 * SCORING_APPLICATION_SELECT). Returns exactly computeFitScore's eight keys.
 */
export function buildFitInputs(application) {
    const requisition = application?.jobRequisition ?? null;
    const candidate = application?.candidate ?? null;
    const skills = requisitionSkillRequirements(requisition) ?? { required: [], preferred: [] };
    return {
        requiredSkills: skills.required ?? [],
        preferredSkills: skills.preferred ?? [],
        candidateSkills: (candidate?.candidateSkills ?? []).map((s) => s?.name).filter(Boolean),
        candidateYears: firstNumber(candidate?.parsedResume, CANDIDATE_YEARS_KEYS),
        minYears: firstNumber(requisition?.jobContent, REQUISITION_MIN_YEARS_KEYS),
        knockedOut: application?.knockedOut === true,
        answerScore: application?.answerScore ?? null,
        answerMaxScore: application?.answerMaxScore ?? null,
    };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score one application and upsert its ApplicationScore. When the inputs hash
 * matches the stored one nothing about the score is rewritten; only updatedAt
 * is stamped as the last check, which is what the job's change scan compares
 * against.
 *
 * @returns {Promise<{applicationId:number, requisitionId:number, status:"SCORED"|"RESCORED"|"UNCHANGED", score:number, band:string}>}
 */
export async function scoreApplication({ tenantId, applicationId, aliasIndex = null, now = new Date() } = {}) {
    if (!tenantId) throw fail("Tenant context is required", "HR-TENANT-REQUIRED", 400);
    const id = Number(applicationId);
    const application = await prisma.application.findFirst({
        where: withTenant(tenantId, { id }),
        select: SCORING_APPLICATION_SELECT,
    });
    if (!application) throw notFound();

    const index = aliasIndex ?? (await loadAliasIndex(tenantId));
    const result = computeFitScore(buildFitInputs(application), { aliasIndex: index });
    const at = new Date(now);

    const existing = await prisma.applicationScore.findFirst({
        where: withTenant(tenantId, { applicationId: id }),
        select: { id: true, inputsHash: true, score: true, band: true },
    });
    const summary = { applicationId: id, requisitionId: application.jobRequisitionId };

    if (existing && existing.inputsHash === result.inputsHash) {
        await tenantTransaction(
            prisma,
            async (tx) => await tx.applicationScore.updateMany({
                where: { tenantId, applicationId: id, inputsHash: result.inputsHash },
                data: { updatedAt: at },
            }),
            { tenantId },
        );
        return { ...summary, status: "UNCHANGED", score: existing.score, band: existing.band };
    }

    const values = {
        requisitionId: application.jobRequisitionId,
        candidateId: application.candidateId,
        score: result.score,
        band: result.band,
        modelVersion: result.modelVersion,
        components: result.components,
        inputsHash: result.inputsHash,
        computedAt: at,
        updatedAt: at,
    };
    await tenantTransaction(
        prisma,
        async (tx) => await tx.applicationScore.upsert({
            where: { applicationId: id },
            create: { tenantId, applicationId: id, ...values },
            update: values,
        }),
        { tenantId },
    );
    return { ...summary, status: existing ? "RESCORED" : "SCORED", score: result.score, band: result.band };
}

/**
 * The tenant's active applications that need a (re)score: never scored, or
 * the application, its candidate (a new parse included) or its requisition
 * changed after the score's last check, or an older model scored it.
 * Unscored first, bounded by limit.
 */
export async function selectApplicationsToScore({ tenantId, limit = DEFAULT_JOB_LIMIT } = {}) {
    const rows = await tenantTransaction(
        prisma,
        async (tx) => await tx.$queryRaw`
            SELECT a.id
              FROM "Application" a
              JOIN "Candidate" c ON c.id = a."candidateId"
              JOIN "JobRequisition" r ON r.id = a."jobRequisitionId"
              LEFT JOIN "application_scores" s ON s."applicationId" = a.id
             WHERE a."tenantId" = ${tenantId}::uuid
               AND NOT (a.stage = ANY(${[...INACTIVE_STAGES]}::text[]))
               AND (s.id IS NULL
                    OR s."modelVersion" <> ${FIT_MODEL_VERSION}
                    OR a."updatedAt" > s."updatedAt"
                    OR c."updatedAt" > s."updatedAt"
                    OR c."parsedAt" > s."updatedAt"
                    OR r."updatedAt" > s."updatedAt")
             ORDER BY (s.id IS NULL) DESC, a.id ASC
             LIMIT ${Number(limit)}`,
        { tenantId },
    );
    return rows.map((row) => Number(row.id));
}

async function scoreTenant({ tenantId, now, limit }) {
    const summary = { scored: 0, rescored: 0, unchanged: 0, failed: 0, proposed: 0, requisitions: 0 };
    const ids = await selectApplicationsToScore({ tenantId, limit });
    if (!ids.length) return summary;

    const aliasIndex = await loadAliasIndex(tenantId);
    const touched = new Set();
    for (const applicationId of ids) {
        try {
            const result = await scoreApplication({ tenantId, applicationId, aliasIndex, now });
            if (result.status === "UNCHANGED") {
                summary.unchanged += 1;
                continue;
            }
            summary[result.status === "SCORED" ? "scored" : "rescored"] += 1;
            touched.add(result.requisitionId);
        } catch (err) {
            summary.failed += 1;
            scoringLog.error({ errMessage: err?.message, tenantId, applicationId }, "scoring job: application failed");
        }
    }

    for (const requisitionId of [...touched].sort((a, b) => a - b)) {
        try {
            const result = await proposeShortlist({ tenantId, requisitionId, now });
            summary.requisitions += 1;
            summary.proposed += result.proposed?.length ?? 0;
        } catch (err) {
            scoringLog.error({ errMessage: err?.message, tenantId, requisitionId }, "scoring job: proposal failed");
        }
    }
    return summary;
}

/**
 * The scheduled scoring sweep. Per tenant: (re)score up to `limit` active
 * applications whose inputs may have changed, then run the proposal step for
 * every requisition that got a new or changed score. Safe to run twice at
 * once: scores upsert on the unique applicationId and proposals serialise on
 * a per-requisition advisory lock.
 */
export async function runApplicationScoringJob({ now = new Date(), limit = DEFAULT_JOB_LIMIT } = {}) {
    if (!isRecruitmentFlagEnabled("scoring")) {
        scoringLog.info("scoring job: scoring flag off — nothing to do");
        return { skipped: "FLAG_OFF" };
    }
    const at = new Date(now);
    // Prisma queries are lazy: await INSIDE the callback so the query runs in
    // the system context, not after run() has returned.
    const tenantRows = await mcpCtx.run({ system: true }, async () =>
        await prisma.application.findMany({
            where: { tenantId: { not: null }, stage: { notIn: [...INACTIVE_STAGES] } },
            select: { tenantId: true },
            distinct: ["tenantId"],
        }),
    );
    const tenants = tenantRows.map((row) => row.tenantId).filter(Boolean);

    const perTenant = [];
    for (const tenantId of tenants) {
        try {
            const result = await mcpCtx.run({ user: { tenantId } }, async () => await scoreTenant({ tenantId, now: at, limit }));
            perTenant.push({ tenantId, ...result });
        } catch (err) {
            scoringLog.error({ errMessage: err?.message, tenantId }, "scoring job: tenant failed");
            perTenant.push({ tenantId, error: err?.message ?? "unknown" });
        }
    }
    const total = (key) => perTenant.reduce((sum, row) => sum + (row[key] ?? 0), 0);
    const summary = {
        tenants: tenants.length,
        scored: total("scored"),
        rescored: total("rescored"),
        unchanged: total("unchanged"),
        failed: total("failed"),
        proposed: total("proposed"),
        perTenant,
    };
    scoringLog.info({ ...summary, perTenant: undefined }, "scoring job: done");
    return summary;
}

// ── Shortlist proposals ──────────────────────────────────────────────────────

/** The event row for a proposal batch: ids and the model version only. */
export function shortlistProposedEvent({ tenantId, requisitionId, applicationIds, modelVersion }, ctx = {}) {
    if (!tenantId) return null;
    return {
        eventName: SHORTLIST_PROPOSED_EVENT,
        tenantId,
        aggregateType: "JobRequisition",
        aggregateId: requisitionId,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            requisitionId: String(requisitionId),
            applicationIds: (applicationIds ?? []).map(String),
            modelVersion,
        },
    };
}

const knockedOutRow = (row) =>
    row?.application?.knockedOut === true
    || (Array.isArray(row?.components) && row.components.some((c) => c?.key === "knockout" && c?.value === 0));

/**
 * Pick the applications to propose from a requisition's ranking (best
 * first). Eligible: score >= threshold, or within the top
 * ceil(n * topPercent / 100) places (at least one place when n > 0; a
 * topPercent of 0 turns the top-share rule off). Never: knocked out, in an
 * inactive stage, already on the shortlist, already proposed once, or scored
 * with no assessed component.
 */
export function selectShortlistProposals(ranked, { threshold, topPercent, shortlisted = new Set() } = {}) {
    const rows = Array.isArray(ranked) ? ranked : [];
    const n = rows.length;
    const top = Number(topPercent) > 0 && n > 0 ? Math.max(1, Math.ceil((n * Number(topPercent)) / 100)) : 0;
    return rows
        .filter((row, index) => {
            if (!(row.score >= Number(threshold) || index < top)) return false;
            if (knockedOutRow(row)) return false;
            if (INACTIVE_STAGES.includes(row.application?.stage)) return false;
            if (shortlisted.has(row.applicationId)) return false;
            if (row.shortlistProposedAt) return false;
            return componentsAssessed(row.components);
        })
        .map((row) => row.applicationId);
}

const canActOnProposals = (scope) =>
    !scope || scope.level === RECRUITMENT_SCOPE.ORG || scope.level === RECRUITMENT_SCOPE.MANAGED;

const scopedApplication = (scope) => (scope && !scope.unrestricted ? { application: applicationScopeWhere(scope) } : {});

/**
 * Propose a requisition's shortlist from its ranking. Idempotent: an
 * application is proposed at most once, and existing entries (MANUAL or a
 * pending proposal) are left as they are. `scope` is the caller's resolved
 * recruitment scope (tools); the job passes none.
 */
export async function proposeShortlist({ tenantId, requisitionId, actorId = null, scope = null, now = new Date(), correlationId } = {}) {
    if (!tenantId) throw fail("Tenant context is required", "HR-TENANT-REQUIRED", 400);
    if (!canActOnProposals(scope)) throw notFound("Requisition");
    const id = Number(requisitionId);
    const requisition = await prisma.jobRequisition.findFirst({
        where: withTenant(tenantId, { id, AND: scope ? [requisitionScopeWhere(scope)] : [] }),
        select: { id: true, status: true },
    });
    if (!requisition) throw notFound("Requisition");
    if (!PROPOSABLE_REQUISITION_STATUSES.includes(requisition.status)) {
        return { requisitionId: id, proposed: [], skipped: "REQUISITION_NOT_OPEN" };
    }

    const settings = await getRecruitmentSettings({ tenantId });
    const threshold = settings.shortlistThreshold;
    const topPercent = settings.shortlistTopPercent;
    const at = new Date(now);

    return tenantTransaction(
        prisma,
        async (tx) => {
            // Two overlapping runs on one requisition must not both propose.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:shortlist-propose:${id}`}, 0))`;
            const ranked = await tx.applicationScore.findMany({
                where: { tenantId, requisitionId: id, application: { stage: { notIn: [...INACTIVE_STAGES] } } },
                select: {
                    applicationId: true,
                    score: true,
                    components: true,
                    shortlistProposedAt: true,
                    application: { select: { stage: true, knockedOut: true } },
                },
                orderBy: RANK_ORDER,
            });
            const entries = ranked.length
                ? await tx.shortlistEntry.findMany({
                    where: { tenantId, applicationId: { in: ranked.map((row) => row.applicationId) } },
                    select: { applicationId: true },
                })
                : [];
            const shortlisted = new Set(entries.map((entry) => entry.applicationId));
            const proposed = selectShortlistProposals(ranked, { threshold, topPercent, shortlisted });
            const result = { requisitionId: id, considered: ranked.length, threshold, topPercent, proposed };
            if (!proposed.length) return result;

            await tx.shortlistEntry.createMany({
                data: proposed.map((applicationId) => ({
                    applicationId,
                    requisitionId: id,
                    tenantId,
                    source: SHORTLIST_SOURCE.PROPOSAL,
                    addedById: null,
                })),
                skipDuplicates: true,
            });
            await tx.applicationScore.updateMany({
                where: { tenantId, applicationId: { in: proposed }, shortlistProposedAt: null },
                data: { shortlistProposedAt: at },
            });
            await enqueueHrDomainEvent(
                tx,
                shortlistProposedEvent(
                    { tenantId, requisitionId: id, applicationIds: proposed, modelVersion: FIT_MODEL_VERSION },
                    eventContext({ actorId, correlationId }),
                ),
            );
            return result;
        },
        { tenantId },
    );
}

/**
 * Confirm one pending proposal: the entry becomes a MANUAL shortlist entry
 * attributed to the confirming recruiter or hiring manager.
 */
export async function confirmShortlistProposal({ tenantId, applicationId, actorId = null, scope = null, now = new Date() } = {}) {
    if (!tenantId) throw fail("Tenant context is required", "HR-TENANT-REQUIRED", 400);
    if (!canActOnProposals(scope)) throw notFound("Shortlist proposal");
    const id = Number(applicationId);
    return tenantTransaction(
        prisma,
        async (tx) => {
            const updated = await tx.shortlistEntry.updateMany({
                where: { tenantId, applicationId: id, source: SHORTLIST_SOURCE.PROPOSAL, ...scopedApplication(scope) },
                data: { source: SHORTLIST_SOURCE.MANUAL, addedById: actorId ?? null, addedAt: new Date(now) },
            });
            if (updated.count === 0) throw notFound("Shortlist proposal");
            await logAction({
                employeeId: actorId ?? null,
                type: "UPDATE",
                module: "Application Shortlist",
                result: "SUCCESS",
                notes: `Shortlist proposal confirmed for application "${id}"`,
                tenantId,
            });
            return { applicationId: id, confirmed: true, source: SHORTLIST_SOURCE.MANUAL, addedById: actorId ?? null };
        },
        { tenantId },
    );
}

/**
 * Dismiss one pending proposal: the entry is removed. The score keeps its
 * shortlistProposedAt, so the application is not proposed again.
 */
export async function dismissShortlistProposal({ tenantId, applicationId, actorId = null, scope = null } = {}) {
    if (!tenantId) throw fail("Tenant context is required", "HR-TENANT-REQUIRED", 400);
    if (!canActOnProposals(scope)) throw notFound("Shortlist proposal");
    const id = Number(applicationId);
    return tenantTransaction(
        prisma,
        async (tx) => {
            const deleted = await tx.shortlistEntry.deleteMany({
                where: { tenantId, applicationId: id, source: SHORTLIST_SOURCE.PROPOSAL, ...scopedApplication(scope) },
            });
            if (deleted.count === 0) throw notFound("Shortlist proposal");
            await logAction({
                employeeId: actorId ?? null,
                type: "DELETE",
                module: "Application Shortlist",
                result: "SUCCESS",
                notes: `Shortlist proposal dismissed for application "${id}"`,
                tenantId,
            });
            return { applicationId: id, dismissed: true };
        },
        { tenantId },
    );
}

// ── Reads ────────────────────────────────────────────────────────────────────

const canReadScores = (scope) =>
    scope?.level === RECRUITMENT_SCOPE.ORG || scope?.level === RECRUITMENT_SCOPE.MANAGED;

const presentScore = (row) => ({
    applicationId: row.applicationId,
    requisitionId: row.requisitionId,
    candidateId: row.candidateId,
    score: row.score,
    band: row.band,
    modelVersion: row.modelVersion,
    components: row.components,
    computedAt: row.computedAt,
    shortlistProposedAt: row.shortlistProposedAt,
});

/** One application's score with its explained components, under the caller's scope. */
export async function getApplicationScore({ tenantId, applicationId, scope } = {}) {
    if (!tenantId) throw fail("Tenant context is required", "HR-TENANT-REQUIRED", 400);
    if (!canReadScores(scope)) throw notFound("Application score");
    const application = await prisma.application.findFirst({
        where: withTenant(tenantId, { id: Number(applicationId), AND: [applicationScopeWhere(scope)] }),
        select: {
            id: true,
            score: {
                select: {
                    applicationId: true,
                    requisitionId: true,
                    candidateId: true,
                    score: true,
                    band: true,
                    modelVersion: true,
                    components: true,
                    computedAt: true,
                    shortlistProposedAt: true,
                },
            },
        },
    });
    if (!application?.score) throw notFound("Application score");
    return presentScore(application.score);
}

const displayName = (candidate) => [candidate?.firstName, candidate?.lastName].filter(Boolean).join(" ").trim();

/**
 * A requisition's scored active applications, best first (score desc, then
 * appliedAt asc), paginated. Rank is the position in the whole ranking.
 */
export async function listRequisitionRanking({ tenantId, requisitionId, scope, page = 1, pageSize = 25 } = {}) {
    if (!tenantId) throw fail("Tenant context is required", "HR-TENANT-REQUIRED", 400);
    if (!canReadScores(scope)) throw notFound("Requisition");
    const id = Number(requisitionId);
    const requisition = await prisma.jobRequisition.findFirst({
        where: withTenant(tenantId, { id, AND: [requisitionScopeWhere(scope)] }),
        select: { id: true },
    });
    if (!requisition) throw notFound("Requisition");

    const size = Math.min(Math.max(1, Number(pageSize) || 25), MAX_PAGE_SIZE);
    const current = Math.max(1, Number(page) || 1);
    const skip = (current - 1) * size;
    const where = withTenant(tenantId, {
        requisitionId: id,
        application: { stage: { notIn: [...INACTIVE_STAGES] }, ...applicationScopeWhere(scope) },
    });

    const [total, rows] = await Promise.all([
        prisma.applicationScore.count({ where }),
        prisma.applicationScore.findMany({
            where,
            orderBy: RANK_ORDER,
            skip,
            take: size,
            select: {
                applicationId: true,
                score: true,
                band: true,
                modelVersion: true,
                computedAt: true,
                shortlistProposedAt: true,
                application: {
                    select: {
                        stage: true,
                        appliedAt: true,
                        knockedOut: true,
                        candidate: { select: { id: true, firstName: true, lastName: true } },
                        shortlist: { select: { source: true } },
                    },
                },
            },
        }),
    ]);

    const items = rows.map((row, index) => {
        const candidate = maskCandidateForScope(row.application?.candidate ?? null, scope);
        const entry = row.application?.shortlist?.[0] ?? null;
        return {
            rank: skip + index + 1,
            applicationId: row.applicationId,
            candidateId: candidate?.id ?? null,
            candidateName: candidate ? displayName(candidate) : null,
            score: row.score,
            band: row.band,
            stage: row.application?.stage ?? null,
            appliedAt: row.application?.appliedAt ?? null,
            knockedOut: row.application?.knockedOut === true,
            shortlist: entry ? { source: entry.source } : null,
            shortlistProposedAt: row.shortlistProposedAt,
            modelVersion: row.modelVersion,
            computedAt: row.computedAt,
        };
    });
    return { items, total, page: current, pageSize: size };
}

export default {
    scoreApplication,
    runApplicationScoringJob,
    proposeShortlist,
    confirmShortlistProposal,
    dismissShortlistProposal,
    getApplicationScore,
    listRequisitionRanking,
};

// src/services/test-result.service.js
//
// Phase 3b — the scored attempt and what the recruiter decides on it (plan
// 7.3.6, 7.3.8 and the "Result" and assessmentStatus tables).
//
//   * SCORING runs on the transaction that closes the sitting: the session
//     becomes SUBMITTED (guarded, so a candidate's submit and the minute job's
//     timeout cannot both score it), the drawn items are scored with their
//     decrypted keys, the CandidateTestResult (one per session) is written,
//     and the interview's assessmentStatus becomes the band, all at once.
//     Events carry ids and the band, never the score.
//   * AUTO-RELEASE. When the blueprint enables it and the score is below its
//     hard floor with no integrity flag, the same transaction runs the
//     release with no decider and reason AUTO_BELOW_FLOOR.
//   * RELEASE cancels the interview through cancelInterview with reason
//     ASSESSMENT_NOT_PASSED (which queues the calendar CANCEL), rejects the
//     application through the workflow with disposition
//     ASSESSMENT_BELOW_THRESHOLD (ASSESSMENT_INTEGRITY for REVIEW), seeding the
//     codes for the tenant when missing, and sets assessmentStatus RELEASED.
//     The candidate's email is Phase 2's: it reacts to the stage change after
//     the tenant's rejection delay. The cancel runs first so it never waits on
//     a row this transaction already locked.
//   * DECISIONS are the recruiter's: PROCEED (an OVERRIDE when the band needed
//     a decision), RELEASE, RETEST (back to CHECKED_IN, the earlier session
//     kept), and WAIVE (no session needed). Every decision but PROCEED on a
//     passing band needs a reason (also a CHECK in the migration).
//   * READS. The test report goes to recruiters, the requisition's manager
//     and the interview's panelists (interviewScopeWhere; anyone else reads
//     not found). It never contains an answer key or the item pool: section
//     scores, the competency chart, time, percentile, the integrity timeline,
//     probe questions for weak competencies and the stems of items the author
//     marked as discussion prompts.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { eventContext } from "../lib/event-context.util.js";
import { interviewScopeWhere } from "../lib/recruitmentAccess.js";
import { assertAssessmentCapability } from "../lib/assessment-access.util.js";
import {
    ASSESSMENT_STATUS,
    DECISION_REQUIRED_BANDS,
    FLAG_INTEGRITY_TYPES,
    LIVE_SESSION_STATUSES,
    RESULT_BAND,
    RESULT_DECISION,
    SESSION_STATUS,
    percentileRank,
    scoreSession,
    shouldAutoRelease,
    timeTakenSeconds,
} from "../lib/test-band.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { cancelInterview } from "./interviewSchedule.service.js";
import { transitionApplicationStage } from "./applicationWorkflow.service.js";
import { ensureDispositionReasonCode } from "./scheduled-disposition.service.js";

const COMPONENT = "test-result";

export const ASSESSMENT_CANCEL_REASON = "ASSESSMENT_NOT_PASSED";
export const AUTO_RELEASE_REASON = "AUTO_BELOW_FLOOR";
export const ASSESSMENT_DISPOSITION_CODES = Object.freeze({
    ASSESSMENT_BELOW_THRESHOLD: { code: "ASSESSMENT_BELOW_THRESHOLD", label: "Assessment below threshold" },
    ASSESSMENT_INTEGRITY: { code: "ASSESSMENT_INTEGRITY", label: "Assessment integrity concern" },
});
export const RELEASE_STAGE_SOURCE = Object.freeze({ AUTO: "system.assessment", RECRUITER: "assessment.release" });

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REASON = 1000;
const MAX_PROBES_PER_COMPETENCY = 3;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const str = (v) => (v === null || v === undefined ? null : String(v));
const positiveInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};
const notFound = () => fail("Test result not found", 404, "HR-RECRUITMENT-TEST-RESULT-NOT-FOUND");

function requireTenant(tenantId) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
}

function cleanReason(reason) {
    const text = typeof reason === "string" ? reason.trim() : "";
    if (text.length > MAX_REASON) throw fail(`The reason must be at most ${MAX_REASON} characters`, 400, "HR-RECRUITMENT-TEST-REASON-INVALID");
    return text || null;
}

// ── Events (ids and vocabulary only) ─────────────────────────────────────────

/**
 * One builder for every Phase 3b assessment event: hr.recruitment.<name>.v1,
 * ids-only payload. Null without a tenant (the enqueue skips it).
 */
export function assessmentEvent(name, { tenantId, aggregateType, aggregateId, actorId = null, payload }) {
    if (!tenantId) return null;
    const ctx = eventContext({ actorId });
    return {
        eventName: `hr.recruitment.${name}.v1`,
        tenantId,
        aggregateType,
        aggregateId,
        actorId: ctx.actorId,
        correlationId: ctx.correlationId,
        payload,
    };
}

/** The interview's routing ids: application, candidate, requisition, recruiter and panel. */
export async function loadInterviewContext(db, tenantId, interviewId) {
    const row = await db.interview.findFirst({
        where: withTenant(tenantId, { id: Number(interviewId) }),
        select: {
            id: true, applicationId: true, status: true, scheduledAt: true, location: true,
            assessmentRequired: true, assessmentStatus: true, assessmentBlueprintId: true,
            interviewers: { select: { employeeId: true } },
            application: { select: { candidateId: true, jobRequisitionId: true, jobRequisition: { select: { requestedById: true } } } },
        },
    });
    if (!row) return null;
    return {
        ...row,
        candidateId: row.application?.candidateId ?? null,
        requisitionId: row.application?.jobRequisitionId ?? null,
        recruiterId: row.application?.jobRequisition?.requestedById ?? null,
        interviewerIds: (row.interviewers ?? []).map((i) => i.employeeId),
    };
}

const routing = (interview) => ({
    interviewId: str(interview.id),
    applicationId: str(interview.applicationId),
    candidateId: str(interview.candidateId),
    requisitionId: str(interview.requisitionId),
    recruiterId: str(interview.recruiterId),
    interviewerIds: (interview.interviewerIds ?? []).map(String),
});

// ── Disposition codes ────────────────────────────────────────────────────────

/**
 * The tenant can resolve the assessment disposition code. A fresh tenant gets
 * the default taxonomy first (Phase 2's seed), then the assessment code is
 * added at version 1; skipDuplicates absorbs a concurrent first release.
 */
export async function ensureAssessmentDispositionCode(tx, tenantId, code) {
    const definition = Object.values(ASSESSMENT_DISPOSITION_CODES).find((c) => c.code === code);
    if (!definition) throw fail(`Unknown assessment disposition code ${code}`, 500, "HR-RECRUITMENT-TEST-DISPOSITION-UNKNOWN");
    await ensureDispositionReasonCode(tx, tenantId, code);
    const existing = await tx.dispositionReasonCode.findFirst({ where: { tenantId, code }, select: { id: true } });
    if (existing) return;
    await tx.dispositionReasonCode.createMany({
        data: [{ tenantId, code, label: definition.label, requiresNotes: false, version: 1, isActive: true }],
        skipDuplicates: true,
    });
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function parseKey(raw, itemId) {
    if (raw && typeof raw === "object") return raw;
    try {
        return JSON.parse(String(raw ?? "{}"));
    } catch {
        logger.warn({ component: COMPONENT, itemId }, "test item answer key is not JSON; the item scores 0");
        return {};
    }
}

/** Scored results of the requisition's other sittings, for the percentile. */
async function requisitionPercentile(db, { tenantId, applicationId, sessionId, scorePct }) {
    const application = await db.application.findFirst({
        where: withTenant(tenantId, { id: applicationId }),
        select: { jobRequisitionId: true },
    });
    if (!application?.jobRequisitionId) return null;
    const siblings = await db.application.findMany({
        where: withTenant(tenantId, { jobRequisitionId: application.jobRequisitionId }),
        select: { id: true },
    });
    const others = await db.candidateTestResult.findMany({
        where: withTenant(tenantId, {
            applicationId: { in: siblings.map((a) => a.id) },
            sessionId: { not: sessionId },
            band: { not: RESULT_BAND.INCOMPLETE },
        }),
        select: { scorePct: true },
    });
    return percentileRank(scorePct, others.map((r) => r.scorePct));
}

async function countFlags(db, tenantId, sessionId) {
    return db.candidateTestIntegrityEvent.count({
        where: withTenant(tenantId, { sessionId, type: { in: [...FLAG_INTEGRITY_TYPES] } }),
    });
}

async function setAssessmentStatus(db, tenantId, interviewId, status, from = null) {
    return db.interview.updateMany({
        where: withTenant(tenantId, { id: interviewId, ...(from ? { assessmentStatus: { in: from } } : {}) }),
        data: { assessmentStatus: status },
    });
}

// The statuses a sitting's own outcome may overwrite; a recruiter's WAIVED
// (or anything decided) is never replaced by a late score.
const RUNNING_STATUSES = Object.freeze([ASSESSMENT_STATUS.CHECKED_IN, ASSESSMENT_STATUS.IN_PROGRESS]);

async function emitRecorded(tx, { tenantId, result, interview, sessionId }) {
    await enqueueHrDomainEvent(
        tx,
        assessmentEvent("test_result_recorded", {
            tenantId,
            aggregateType: "CandidateTestResult",
            aggregateId: result.id,
            payload: { resultId: str(result.id), sessionId: str(sessionId), band: result.band, ...routing(interview) },
        }),
    );
}

/**
 * An INCOMPLETE result for a sitting that produced no scored attempt (voided,
 * expired, abandoned). Idempotent per session. Runs on the caller's tx.
 */
export async function recordIncompleteResult(tx, { session, now = new Date() }) {
    const tenantId = session.tenantId;
    const existing = await tx.candidateTestResult.findFirst({ where: withTenant(tenantId, { sessionId: session.id }) });
    if (existing) return existing;
    const interview = await loadInterviewContext(tx, tenantId, session.interviewId);
    const blueprint = await tx.candidateTestBlueprint.findFirst({
        where: withTenant(tenantId, { id: session.blueprintId }),
        select: { jobFamily: true },
    });
    const result = await tx.candidateTestResult.create({
        data: {
            tenantId,
            sessionId: session.id,
            applicationId: session.applicationId,
            interviewId: session.interviewId,
            candidateId: session.candidateId,
            blueprintId: session.blueprintId,
            jobFamily: blueprint?.jobFamily ?? null,
            rawScore: 0,
            maxScore: Array.isArray(session.itemOrder) ? session.itemOrder.length : 0,
            scorePct: 0,
            sectionScores: [],
            band: RESULT_BAND.INCOMPLETE,
            integrityFlagCount: await countFlags(tx, tenantId, session.id),
            timeTakenSec: timeTakenSeconds(session, now),
        },
    });
    await setAssessmentStatus(tx, tenantId, session.interviewId, ASSESSMENT_STATUS.INCOMPLETE, RUNNING_STATUSES);
    if (interview) await emitRecorded(tx, { tenantId, result, interview, sessionId: session.id });
    return result;
}

/**
 * Close a running sitting and score it, on the caller's transaction.
 * @param {object} tx
 * @param {{ session: object, reason: "CANDIDATE"|"TIMEOUT"|"PROCTOR", now?: Date }} args
 * @returns {Promise<{ result: object|null, finalized: boolean, autoReleased?: boolean }>}
 */
export async function finalizeSession(tx, { session, reason, now = new Date() }) {
    const tenantId = session.tenantId;
    const pausedTotalSec = session.pausedAt
        ? (session.pausedTotalSec ?? 0) + Math.max(0, Math.floor((now.getTime() - new Date(session.pausedAt).getTime()) / 1000))
        : session.pausedTotalSec ?? 0;
    const claim = await tx.candidateTestSession.updateMany({
        where: withTenant(tenantId, { id: session.id, status: { in: [SESSION_STATUS.IN_PROGRESS, SESSION_STATUS.PAUSED] } }),
        data: { status: SESSION_STATUS.SUBMITTED, submittedAt: now, submitReason: reason, pausedAt: null, pausedTotalSec },
    });
    if (!claim.count) {
        const result = await tx.candidateTestResult.findFirst({ where: withTenant(tenantId, { sessionId: session.id }) });
        return { result, finalized: false };
    }
    const closed = { ...session, pausedAt: null, pausedTotalSec };
    const interview = await loadInterviewContext(tx, tenantId, session.interviewId);

    await enqueueHrDomainEvent(
        tx,
        assessmentEvent("test_session_submitted", {
            tenantId,
            aggregateType: "CandidateTestSession",
            aggregateId: session.id,
            payload: { sessionId: str(session.id), submitReason: reason, ...(interview ? routing(interview) : {}) },
        }),
    );

    // The clock never started: nothing was served, so there is nothing to score.
    if (!session.startedAt) return { result: await recordIncompleteResult(tx, { session: closed, now }), finalized: true };

    const order = Array.isArray(session.itemOrder) ? session.itemOrder : [];
    const blueprint = await tx.candidateTestBlueprint.findFirst({ where: withTenant(tenantId, { id: session.blueprintId }) });
    const itemRows = await tx.candidateTestItem.findMany({
        where: withTenant(tenantId, { id: { in: order.map((e) => Number(e.itemId)) } }),
        // The one place the answer key is read: scoring, server-side.
        select: { id: true, type: true, answerKey: true, scoringRule: true },
    });
    const byId = new Map(itemRows.map((row) => [row.id, row]));
    const items = order.map((entry) => {
        const row = byId.get(Number(entry.itemId));
        return {
            itemId: Number(entry.itemId),
            sectionKey: entry.sectionKey,
            type: row?.type,
            scoringRule: row?.scoringRule ?? null,
            answerKey: parseKey(row?.answerKey, entry.itemId),
        };
    });
    const responses = await tx.candidateTestResponse.findMany({
        where: withTenant(tenantId, { sessionId: session.id }),
        select: { itemId: true, answer: true },
    });
    const integrityFlagCount = await countFlags(tx, tenantId, session.id);
    const scored = scoreSession({ items, responses, blueprint: blueprint ?? {}, integrityFlagCount });
    const percentile = await requisitionPercentile(tx, {
        tenantId, applicationId: session.applicationId, sessionId: session.id, scorePct: scored.scorePct,
    });
    const validityDays = Math.max(0, Number(blueprint?.resultValidityDays ?? 90));

    const result = await tx.candidateTestResult.create({
        data: {
            tenantId,
            sessionId: session.id,
            applicationId: session.applicationId,
            interviewId: session.interviewId,
            candidateId: session.candidateId,
            blueprintId: session.blueprintId,
            jobFamily: blueprint?.jobFamily ?? null,
            rawScore: scored.rawScore,
            maxScore: scored.maxScore,
            scorePct: scored.scorePct,
            sectionScores: scored.sectionScores,
            mustPassFailed: scored.mustPassFailed,
            band: scored.band,
            percentile,
            integrityFlagCount: scored.integrityFlagCount,
            timeTakenSec: timeTakenSeconds(closed, now),
            validUntil: new Date(now.getTime() + validityDays * DAY_MS),
        },
    });

    if (interview) await emitRecorded(tx, { tenantId, result, interview, sessionId: session.id });
    if (interview && scored.band === RESULT_BAND.REVIEW) {
        await enqueueHrDomainEvent(
            tx,
            assessmentEvent("test_integrity_flagged", {
                tenantId,
                aggregateType: "CandidateTestResult",
                aggregateId: result.id,
                payload: {
                    resultId: str(result.id),
                    sessionId: str(session.id),
                    integrityFlagCount: scored.integrityFlagCount,
                    ...routing(interview),
                },
            }),
        );
    }

    const auto = interview && shouldAutoRelease({
        blueprint: blueprint ?? {}, scorePct: scored.scorePct, integrityFlagCount: scored.integrityFlagCount, band: scored.band,
    });
    if (auto) {
        await releaseInTransaction(tx, { tenantId, result, interview, decidedById: null, reason: AUTO_RELEASE_REASON, now });
        return { result: { ...result, decision: RESULT_DECISION.RELEASE }, finalized: true, autoReleased: true };
    }
    await setAssessmentStatus(tx, tenantId, session.interviewId, scored.band, RUNNING_STATUSES);
    return { result, finalized: true, autoReleased: false };
}

// ── Release ──────────────────────────────────────────────────────────────────

/**
 * Release on the caller's transaction (see the module header). `interview` is
 * a loadInterviewContext row. Emits test_result_decided.
 */
export async function releaseInTransaction(tx, { tenantId, result, interview, decidedById = null, reason, now = new Date() }) {
    const disposition = result.band === RESULT_BAND.REVIEW
        ? ASSESSMENT_DISPOSITION_CODES.ASSESSMENT_INTEGRITY.code
        : ASSESSMENT_DISPOSITION_CODES.ASSESSMENT_BELOW_THRESHOLD.code;
    await ensureAssessmentDispositionCode(tx, tenantId, disposition);

    // First, before this transaction touches the interview row.
    if (interview.status === "SCHEDULED") {
        await cancelInterview({
            interviewId: interview.id,
            reasonCode: ASSESSMENT_CANCEL_REASON,
            notes: reason,
            tenantId,
            actorId: decidedById,
            db: tx,
        });
    }
    await transitionApplicationStage({
        id: interview.applicationId,
        tenantId,
        targetStage: "rejected",
        reason: disposition,
        actorId: decidedById,
        source: decidedById ? RELEASE_STAGE_SOURCE.RECRUITER : RELEASE_STAGE_SOURCE.AUTO,
        db: tx,
    });
    await setAssessmentStatus(tx, tenantId, interview.id, ASSESSMENT_STATUS.RELEASED);
    await tx.candidateTestResult.update({
        where: { id: result.id },
        data: { decision: RESULT_DECISION.RELEASE, decidedById, decisionReason: reason, decidedAt: now },
    });
    await emitDecided(tx, { tenantId, resultId: result.id, interview, decision: RESULT_DECISION.RELEASE, decidedById, dispositionCode: disposition });
    return { disposition };
}

async function emitDecided(tx, { tenantId, resultId, interview, decision, decidedById, dispositionCode = null }) {
    await enqueueHrDomainEvent(
        tx,
        assessmentEvent("test_result_decided", {
            tenantId,
            aggregateType: resultId ? "CandidateTestResult" : "Interview",
            aggregateId: resultId ?? interview.id,
            actorId: decidedById,
            payload: {
                resultId: str(resultId),
                decision,
                automatic: decidedById === null,
                decidedById: str(decidedById),
                dispositionCode,
                ...routing(interview),
            },
        }),
    );
}

// ── Decisions ────────────────────────────────────────────────────────────────

const PASSING_BANDS = Object.freeze([RESULT_BAND.PASSED, RESULT_BAND.BORDERLINE]);

/**
 * The recruiter's decision on a result.
 * @param {{ tenantId, resultId, decision: "PROCEED"|"OVERRIDE"|"RELEASE"|"RETEST", reason?, access, actorId?, now? }} args
 */
export async function decideTestResult({ tenantId, resultId, decision, reason, access, actorId = null, now = new Date() }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "recruiter", "Only a recruiter can decide a test result");
    const id = positiveInt(resultId);
    if (!id) throw notFound();
    const asked = String(decision ?? "").trim().toUpperCase();
    const text = cleanReason(reason);
    const actor = positiveInt(actorId);

    return tenantTransaction(
        prisma,
        async (tx) => {
            const result = await tx.candidateTestResult.findFirst({ where: withTenant(tenantId, { id }) });
            if (!result) throw notFound();
            if (result.decision) throw fail(`This result was already decided (${result.decision})`, 409, "HR-RECRUITMENT-TEST-RESULT-DECIDED");
            const interview = await loadInterviewContext(tx, tenantId, result.interviewId);
            if (!interview) throw notFound();
            if (interview.assessmentStatus !== result.band) {
                throw fail("The interview's assessment has moved on since this result", 409, "HR-RECRUITMENT-TEST-RESULT-STALE");
            }
            const needsDecision = DECISION_REQUIRED_BANDS.includes(result.band);
            const stored = asked === RESULT_DECISION.PROCEED && needsDecision ? RESULT_DECISION.OVERRIDE : asked;
            if (![RESULT_DECISION.PROCEED, RESULT_DECISION.OVERRIDE, RESULT_DECISION.RELEASE, RESULT_DECISION.RETEST].includes(stored)) {
                throw fail("decision must be PROCEED, OVERRIDE, RELEASE or RETEST", 400, "HR-RECRUITMENT-TEST-DECISION-INVALID");
            }
            if (stored !== RESULT_DECISION.PROCEED && !needsDecision) {
                throw fail(`A ${result.band} result can only proceed`, 409, "HR-RECRUITMENT-TEST-DECISION-INVALID");
            }
            if (stored !== RESULT_DECISION.PROCEED && !text) {
                throw fail("A reason is required for this decision", 400, "HR-RECRUITMENT-TEST-REASON-REQUIRED");
            }

            if (stored === RESULT_DECISION.RELEASE) {
                const { disposition } = await releaseInTransaction(tx, { tenantId, result, interview, decidedById: actor, reason: text, now });
                return { resultId: result.id, decision: stored, assessmentStatus: ASSESSMENT_STATUS.RELEASED, dispositionCode: disposition };
            }
            const nextStatus = {
                [RESULT_DECISION.PROCEED]: result.band,
                [RESULT_DECISION.OVERRIDE]: ASSESSMENT_STATUS.OVERRIDDEN,
                [RESULT_DECISION.RETEST]: ASSESSMENT_STATUS.CHECKED_IN,
            }[stored];
            await tx.candidateTestResult.update({
                where: { id: result.id },
                data: { decision: stored, decidedById: actor, decisionReason: text, decidedAt: now },
            });
            if (nextStatus !== result.band) await setAssessmentStatus(tx, tenantId, interview.id, nextStatus, [result.band]);
            await emitDecided(tx, { tenantId, resultId: result.id, interview, decision: stored, decidedById: actor });
            return { resultId: result.id, decision: stored, assessmentStatus: nextStatus };
        },
        { tenantId },
    );
}

const WAIVABLE = Object.freeze([
    ASSESSMENT_STATUS.REQUIRED,
    ASSESSMENT_STATUS.CHECKED_IN,
    ASSESSMENT_STATUS.FAILED,
    ASSESSMENT_STATUS.REVIEW,
    ASSESSMENT_STATUS.INCOMPLETE,
]);

/**
 * Waive the test for one interview (internal candidate, senior role,
 * accessibility). No session needed; a live session must be voided first.
 */
export async function waiveAssessment({ tenantId, interviewId, reason, access, actorId = null, now = new Date() }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "recruiter", "Only a recruiter can waive the test");
    const id = positiveInt(interviewId);
    if (!id) throw fail("Interview not found", 404, "HR-RECRUITMENT-TEST-INTERVIEW-NOT-FOUND");
    const text = cleanReason(reason);
    if (!text) throw fail("A reason is required to waive the test", 400, "HR-RECRUITMENT-TEST-REASON-REQUIRED");
    const actor = positiveInt(actorId);

    return tenantTransaction(
        prisma,
        async (tx) => {
            const interview = await loadInterviewContext(tx, tenantId, id);
            if (!interview || !interview.assessmentRequired) throw fail("Interview not found", 404, "HR-RECRUITMENT-TEST-INTERVIEW-NOT-FOUND");
            if (!WAIVABLE.includes(interview.assessmentStatus)) {
                throw fail(`The test cannot be waived from ${interview.assessmentStatus}`, 409, "HR-RECRUITMENT-TEST-WAIVE-INVALID");
            }
            const live = await tx.candidateTestSession.count({
                where: withTenant(tenantId, { interviewId: id, status: { in: [...LIVE_SESSION_STATUSES] } }),
            });
            if (live) throw fail("Void the live test session before waiving the test", 409, "HR-RECRUITMENT-TEST-SESSION-LIVE");
            const moved = await tx.interview.updateMany({
                where: withTenant(tenantId, { id, assessmentStatus: interview.assessmentStatus }),
                data: { assessmentStatus: ASSESSMENT_STATUS.WAIVED, assessmentWaivedReason: text, assessmentWaivedById: actor },
            });
            if (!moved.count) throw fail("The interview's assessment changed; try again", 409, "HR-RECRUITMENT-TEST-RESULT-STALE");
            const pending = await tx.candidateTestResult.findFirst({
                where: withTenant(tenantId, { interviewId: id, decision: null, band: { in: [...DECISION_REQUIRED_BANDS] } }),
                orderBy: { id: "desc" },
            });
            if (pending) {
                await tx.candidateTestResult.update({
                    where: { id: pending.id },
                    data: { decision: RESULT_DECISION.WAIVE, decidedById: actor, decisionReason: text, decidedAt: now },
                });
            }
            await emitDecided(tx, { tenantId, resultId: pending?.id ?? null, interview, decision: RESULT_DECISION.WAIVE, decidedById: actor });
            return { interviewId: id, assessmentStatus: ASSESSMENT_STATUS.WAIVED, resultId: pending?.id ?? null };
        },
        { tenantId },
    );
}

// ── Reads ────────────────────────────────────────────────────────────────────

const RESULT_SUMMARY = Object.freeze({
    id: true, sessionId: true, interviewId: true, applicationId: true, candidateId: true, blueprintId: true,
    band: true, scorePct: true, mustPassFailed: true, integrityFlagCount: true, percentile: true,
    decision: true, decidedAt: true, validUntil: true, createdAt: true,
});

const summarize = (row) => ({
    resultId: row.id,
    sessionId: row.sessionId,
    interviewId: row.interviewId,
    applicationId: row.applicationId,
    candidateId: row.candidateId,
    band: row.band,
    scorePct: row.scorePct,
    mustPassFailed: row.mustPassFailed,
    integrityFlagCount: row.integrityFlagCount,
    percentile: row.percentile,
    decision: row.decision ?? null,
    decidedAt: row.decidedAt ?? null,
    validUntil: row.validUntil ?? null,
    createdAt: row.createdAt,
});

/** The interview, if the caller's recruitment scope reaches it. */
async function visibleInterview(tenantId, scope, interviewId) {
    return prisma.interview.findFirst({
        where: withTenant(tenantId, { id: interviewId, ...interviewScopeWhere(scope) }),
        select: {
            id: true, applicationId: true, assessmentStatus: true, assessmentRequired: true,
            assessmentWaivedReason: true, assessmentWaivedById: true,
        },
    });
}

/** Published probe questions for the weak competencies, latest version per key. */
async function probeQuestions(tenantId, competencyKeys) {
    if (!competencyKeys.length) return [];
    const rows = await prisma.interviewQuestion.findMany({
        where: withTenant(tenantId, { status: "PUBLISHED", competencyKey: { in: competencyKeys } }),
        select: { questionKey: true, version: true, competencyKey: true, prompt: true, followUps: true, goodAnswerGuide: true, level: true },
        orderBy: [{ questionKey: "asc" }, { version: "desc" }],
    });
    const latest = new Map();
    for (const row of rows) {
        const held = latest.get(row.questionKey);
        if (!held || row.version > held.version) latest.set(row.questionKey, row);
    }
    return competencyKeys.map((key) => ({
        competencyKey: key,
        questions: [...latest.values()].filter((q) => q.competencyKey === key).slice(0, MAX_PROBES_PER_COMPETENCY)
            .map(({ version: _v, ...q }) => q),
    }));
}

/**
 * The test report for one result (or an interview's latest result). Never
 * contains an answer key, a rationale or any item the candidate was not shown.
 */
export async function getTestResultReport({ tenantId, scope, resultId, interviewId }) {
    requireTenant(tenantId);
    const rid = positiveInt(resultId);
    const iid = positiveInt(interviewId);
    if (!rid && !iid) throw fail("resultId or interviewId is required", 400, "HR-RECRUITMENT-TEST-RESULT-ID-REQUIRED");

    const result = rid
        ? await prisma.candidateTestResult.findFirst({ where: withTenant(tenantId, { id: rid }) })
        : await prisma.candidateTestResult.findFirst({ where: withTenant(tenantId, { interviewId: iid }), orderBy: { id: "desc" } });
    if (rid && !result) throw notFound();
    const interview = await visibleInterview(tenantId, scope, result?.interviewId ?? iid);
    if (!interview) throw notFound();
    const waiver = interview.assessmentStatus === ASSESSMENT_STATUS.WAIVED
        ? { reason: interview.assessmentWaivedReason ?? null, waivedById: interview.assessmentWaivedById ?? null }
        : null;
    if (!result) return { interviewId: interview.id, assessmentStatus: interview.assessmentStatus, waiver, result: null };

    const [blueprint, session, events] = await Promise.all([
        prisma.candidateTestBlueprint.findFirst({
            where: withTenant(tenantId, { id: result.blueprintId }),
            select: { id: true, name: true, version: true, passMarkPct: true, borderlineBandPct: true, durationMin: true, integrityFlagThreshold: true },
        }),
        prisma.candidateTestSession.findFirst({
            where: withTenant(tenantId, { id: result.sessionId }),
            select: { id: true, itemOrder: true, attemptNo: true, startedAt: true, submittedAt: true, submitReason: true, extraTimePct: true },
        }),
        prisma.candidateTestIntegrityEvent.findMany({
            where: withTenant(tenantId, { sessionId: result.sessionId }),
            select: { type: true, source: true, occurredAt: true, detail: true },
            orderBy: { occurredAt: "asc" },
        }),
    ]);

    const sections = Array.isArray(result.sectionScores) ? result.sectionScores : [];
    const passMark = blueprint?.passMarkPct ?? 60;
    const weak = [...new Set(
        sections.filter((s) => s.competencyKey && (!s.passed || (s.scorePct !== null && s.scorePct < passMark))).map((s) => s.competencyKey),
    )];
    const order = Array.isArray(session?.itemOrder) ? session.itemOrder : [];
    const discussion = order.length
        ? await prisma.candidateTestItem.findMany({
            where: withTenant(tenantId, { id: { in: order.map((e) => Number(e.itemId)) }, discussionPrompt: true }),
            // The stem only: no options, key or rationale.
            select: { id: true, stem: true, competencyKey: true },
        })
        : [];
    const position = new Map(order.map((e) => [Number(e.itemId), e.n]));
    const percentile = await requisitionPercentile(prisma, {
        tenantId, applicationId: result.applicationId, sessionId: result.sessionId, scorePct: result.scorePct,
    });
    const showDetail = scope?.unrestricted === true;

    return {
        interviewId: interview.id,
        assessmentStatus: interview.assessmentStatus,
        waiver,
        result: {
            ...summarize(result),
            rawScore: result.rawScore,
            maxScore: result.maxScore,
            percentile: percentile ?? result.percentile ?? null,
            timeTakenSec: result.timeTakenSec ?? null,
            decisionReason: result.decisionReason ?? null,
            blueprint: blueprint
                ? { id: blueprint.id, name: blueprint.name, version: blueprint.version, passMarkPct: blueprint.passMarkPct, borderlineBandPct: blueprint.borderlineBandPct, durationMin: blueprint.durationMin }
                : null,
            attemptNo: session?.attemptNo ?? null,
            submitReason: session?.submitReason ?? null,
            extraTimePct: session?.extraTimePct ?? 0,
            sectionScores: sections.map((s) => ({
                key: s.key, label: s.label, competencyKey: s.competencyKey, scorePct: s.scorePct,
                passMarkPct: s.passMarkPct, passed: s.passed, mustPass: s.mustPass,
            })),
            competencyChart: sections.map((s) => ({ competencyKey: s.competencyKey, label: s.label, scorePct: s.scorePct, passMarkPct: s.passMarkPct })),
            integrity: {
                flagCount: result.integrityFlagCount,
                threshold: blueprint?.integrityFlagThreshold ?? null,
                events: events.map((e) => ({ type: e.type, source: e.source, occurredAt: e.occurredAt, ...(showDetail ? { detail: e.detail ?? null } : {}) })),
            },
            probes: await probeQuestions(tenantId, weak),
            discussionPrompts: discussion
                .map((item) => ({ n: position.get(item.id) ?? null, competencyKey: item.competencyKey, stem: item.stem }))
                .sort((a, b) => (a.n ?? 0) - (b.n ?? 0)),
        },
    };
}

/** Results for a requisition or an interview, cut to the interviews the caller can see. */
/**
 * Results for a requisition, an interview or a candidate, within the caller's
 * interview scope. `decisionPending` keeps the results still waiting for a
 * recruiter (a FAILED, REVIEW or INCOMPLETE band with no decision). Each row
 * carries the candidate's display name; scope already limits who reads it.
 */
export async function listTestResults({
    tenantId, scope, requisitionId, interviewId, candidateId, band, decisionPending = false, page = 1, limit = 50,
}) {
    requireTenant(tenantId);
    const reqId = positiveInt(requisitionId);
    const iid = positiveInt(interviewId);
    const cid = positiveInt(candidateId);
    if (!reqId && !iid && !cid) {
        throw fail("requisitionId, interviewId or candidateId is required", 400, "HR-RECRUITMENT-TEST-RESULT-ID-REQUIRED");
    }
    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const pageNo = Math.max(Number(page) || 1, 1);
    const application = {
        ...(reqId ? { jobRequisitionId: reqId } : {}),
        ...(cid ? { candidateId: cid } : {}),
    };
    const interviews = await prisma.interview.findMany({
        where: withTenant(tenantId, {
            ...interviewScopeWhere(scope),
            ...(iid ? { id: iid } : {}),
            ...(Object.keys(application).length ? { application } : {}),
        }),
        select: { id: true },
        take: 5000,
    });
    const wanted = band ? String(band).trim().toUpperCase() : null;
    const pendingBands = wanted ? DECISION_REQUIRED_BANDS.filter((b) => b === wanted) : [...DECISION_REQUIRED_BANDS];
    const bandWhere = decisionPending
        ? { band: { in: pendingBands }, decision: null }
        : wanted ? { band: wanted } : {};
    const where = withTenant(tenantId, { interviewId: { in: interviews.map((i) => i.id) }, ...bandWhere });
    const [rows, total] = await Promise.all([
        prisma.candidateTestResult.findMany({ where, select: RESULT_SUMMARY, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (pageNo - 1) * take, take }),
        prisma.candidateTestResult.count({ where }),
    ]);
    const candidateIds = [...new Set(rows.map((r) => r.candidateId).filter(Boolean))];
    const people = candidateIds.length
        ? await prisma.candidate.findMany({
            where: withTenant(tenantId, { id: { in: candidateIds } }),
            select: { id: true, firstName: true, lastName: true },
        })
        : [];
    const nameOf = new Map(people.map((p) => [p.id, [p.firstName, p.lastName].filter(Boolean).join(" ") || null]));
    return {
        items: rows.map((row) => ({ ...summarize(row), candidateName: nameOf.get(row.candidateId) ?? null })),
        total,
        page: pageNo,
        limit: take,
    };
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const mean = (list) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);

function aggregate(rows) {
    const completed = rows.filter((r) => r.band !== RESULT_BAND.INCOMPLETE);
    const passed = completed.filter((r) => PASSING_BANDS.includes(r.band));
    const decisionNeeded = rows.filter((r) => DECISION_REQUIRED_BANDS.includes(r.band));
    const overrides = decisionNeeded.filter((r) => r.decision === RESULT_DECISION.OVERRIDE);
    return {
        sittings: rows.length,
        completed: completed.length,
        passed: passed.length,
        passRatePct: pct(passed.length, completed.length),
        decisionsNeeded: decisionNeeded.length,
        overrides: overrides.length,
        overrideRatePct: pct(overrides.length, decisionNeeded.length),
        released: rows.filter((r) => r.decision === RESULT_DECISION.RELEASE).length,
        averageScorePct: mean(completed.map((r) => r.scorePct)),
        averageTimeTakenSec: mean(completed.map((r) => r.timeTakenSec).filter((t) => Number.isFinite(t))),
    };
}

function groupBy(rows, keyOf) {
    const groups = new Map();
    for (const row of rows) {
        const key = keyOf(row) ?? "UNKNOWN";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return [...groups.entries()].map(([key, list]) => ({ key: String(key), ...aggregate(list) }))
        .sort((a, b) => b.sittings - a.sittings || a.key.localeCompare(b.key));
}

/**
 * Pass rates by requisition, source and site, the override rate per
 * requisition (a high rate means the pass mark needs review), average score
 * and completion time. Recruiters only.
 */
export async function getTestAnalytics({ tenantId, access, requisitionId, from, to }) {
    requireTenant(tenantId);
    assertAssessmentCapability(access, "recruiter", "Only a recruiter can read test analytics");
    const reqId = positiveInt(requisitionId);
    const since = from ? new Date(from) : null;
    const until = to ? new Date(to) : null;
    for (const d of [since, until]) {
        if (d && Number.isNaN(d.getTime())) throw fail("from and to must be ISO dates", 400, "HR-RECRUITMENT-TEST-ANALYTICS-INVALID");
    }
    const appFilter = reqId
        ? (await prisma.application.findMany({ where: withTenant(tenantId, { jobRequisitionId: reqId }), select: { id: true } })).map((a) => a.id)
        : null;
    const rows = await prisma.candidateTestResult.findMany({
        where: withTenant(tenantId, {
            ...(appFilter ? { applicationId: { in: appFilter } } : {}),
            ...(since || until ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } } : {}),
        }),
        select: { id: true, applicationId: true, sessionId: true, band: true, scorePct: true, timeTakenSec: true, decision: true },
        take: 10000,
    });
    const appIds = [...new Set(rows.map((r) => r.applicationId))];
    const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
    const [apps, sessions] = await Promise.all([
        appIds.length
            ? prisma.application.findMany({ where: withTenant(tenantId, { id: { in: appIds } }), select: { id: true, jobRequisitionId: true, sourceChannel: true } })
            : [],
        sessionIds.length
            ? prisma.candidateTestSession.findMany({ where: withTenant(tenantId, { id: { in: sessionIds } }), select: { id: true, siteRef: true } })
            : [],
    ]);
    const appById = new Map(apps.map((a) => [a.id, a]));
    const siteById = new Map(sessions.map((s) => [s.id, s.siteRef]));
    return {
        overall: aggregate(rows),
        byRequisition: groupBy(rows, (r) => appById.get(r.applicationId)?.jobRequisitionId),
        bySource: groupBy(rows, (r) => appById.get(r.applicationId)?.sourceChannel),
        bySite: groupBy(rows, (r) => siteById.get(r.sessionId)),
    };
}

export default {
    finalizeSession,
    recordIncompleteResult,
    releaseInTransaction,
    decideTestResult,
    waiveAssessment,
    getTestResultReport,
    listTestResults,
    getTestAnalytics,
};

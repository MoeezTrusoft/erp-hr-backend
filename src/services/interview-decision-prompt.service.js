// src/services/interview-decision-prompt.service.js
//
// Recruitment Phase 3a — the hiring manager's DECISION PROMPT and the
// automatic advance on a NEXT_ROUND decision (flag decisionPrompts).
//
// The plan: "When every panel scorecard is submitted, consolidate feedback and
// prompt the hiring manager to decide; a NEXT_ROUND decision advances the
// application automatically. Hiring manager decides."
//
// The rules this file holds:
//
//   * PROMPT ONCE. An interview is ready when it is COMPLETED (or its slot has
//     ended), it has no decision, and every active panelist (assignment not
//     "declined") has a SUBMITTED scorecard. The prompt claims the interview by
//     stamping decisionPromptedAt with a guarded update, records one
//     DECISION_PROMPT row for the hiring manager and enqueues the event, all in
//     one transaction. The scorecard submit path and the job both call the same
//     function, so whichever comes first prompts and the other finds nothing.
//     (The scorecard row itself is written by interview-scorecard.service.js on
//     its own connection, in SYSTEM context for legacy rows, so it cannot join
//     this transaction; if the prompt fails after the scorecard committed, the
//     job prompts on its next run.)
//   * THE HUMAN DECIDES. Nothing here records a decision. The prompt carries
//     ids and recommendation counts only; the hiring manager reads the
//     consolidated feedback through the existing scoped reads.
//   * AUTO-ADVANCE, AND ONLY FORWARD. When a NEXT_ROUND decision is recorded:
//       - a FINAL interview with no other round still scheduled moves the
//         application from "interview" to "offer" through the recruiter's own
//         workflow transition (source "system.decision_auto_advance"): the
//         FINAL interview type is the model's final-round marker, and the
//         offer stage is where a recruiter drafts the offer (nothing is drafted
//         or sent automatically);
//       - any other interview keeps the application in "interview" and emits
//         hr.recruitment.application_next_round.v1 so a recruiter schedules
//         the next round, unless one is already scheduled;
//       - a workflow refusal (stage moved by a human, prerequisite missing)
//         leaves the decision standing and moves nothing;
//       - REJECTED never auto-rejects: a rejection needs a human disposition
//         with its reason, so it is left to the recruiter. HOLD does nothing.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { mcpCtx } from "../mcp/context.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { eventContext } from "../lib/event-context.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { transitionApplicationStage } from "./application-workflow.service.js";
import { consolidateInterviewFeedback } from "./interview-mgmt.service.js";
import {
    REMINDER_KIND,
    activePanel,
    employeeRecipientKey,
    hiringManagerEmployeeIdOf,
    interviewEnd,
    missingScorecards,
} from "./interview-reminder.service.js";

const COMPONENT = "interview-decision-prompt";

export const DECISION_PROMPT_EVENT = "hr.recruitment.interview_decision_prompt.v1";
export const APPLICATION_NEXT_ROUND_EVENT = "hr.recruitment.application_next_round.v1";
export const AUTO_ADVANCE_SOURCE = "system.decision_auto_advance";
export const FINAL_ROUND_TYPE = "FINAL";

const DAY_MS = 24 * 60 * 60 * 1000;
const PROMPT_LOOKBACK_MS = 30 * DAY_MS;
const DEFAULT_LIMIT = 200;

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

// ── Events ───────────────────────────────────────────────────────────────────

/** hr.recruitment.interview_decision_prompt.v1 — ids and counts only. */
export function decisionPromptEvent(
    { tenantId, interviewId, applicationId, requisitionId, hiringManagerEmployeeId, recommendationCounts = {} },
    ctx = {},
) {
    if (!tenantId) return null;
    return {
        eventName: DECISION_PROMPT_EVENT,
        tenantId,
        aggregateType: "Interview",
        aggregateId: interviewId,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            interviewId: String(interviewId),
            applicationId: applicationId != null ? String(applicationId) : null,
            requisitionId: requisitionId != null ? String(requisitionId) : null,
            hiringManagerEmployeeId: hiringManagerEmployeeId != null ? String(hiringManagerEmployeeId) : null,
            recommendationCounts: { ...recommendationCounts },
        },
    };
}

/** hr.recruitment.application_next_round.v1 — a recruiter schedules the next round. */
export function applicationNextRoundEvent({ tenantId, applicationId, requisitionId, interviewId, interviewType }, ctx = {}) {
    if (!tenantId) return null;
    return {
        eventName: APPLICATION_NEXT_ROUND_EVENT,
        tenantId,
        aggregateType: "Application",
        aggregateId: applicationId,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            applicationId: String(applicationId),
            requisitionId: requisitionId != null ? String(requisitionId) : null,
            interviewId: String(interviewId),
            interviewType: interviewType ?? null,
        },
    };
}

// ── Readiness (pure) ─────────────────────────────────────────────────────────

/**
 * Is this interview due a decision prompt? Needs status, decision,
 * decisionPromptedAt, scheduledAt, durationMinutes, interviewers, scorecards.
 */
export function isReadyForDecisionPrompt(interview, now = new Date()) {
    if (!interview || interview.decision || interview.decisionPromptedAt) return false;
    const over =
        interview.status === "COMPLETED" ||
        (interview.status === "SCHEDULED" && new Date(now).getTime() >= interviewEnd(interview).getTime());
    if (!over) return false;
    return activePanel(interview).length > 0 && missingScorecards(interview).length === 0;
}

const PROMPT_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    applicationId: true,
    status: true,
    decision: true,
    decisionPromptedAt: true,
    scheduledAt: true,
    durationMinutes: true,
    interviewers: { select: { employeeId: true, status: true } },
    scorecards: { select: { reviewerId: true, submittedAt: true } },
    application: {
        select: { jobRequisitionId: true, jobRequisition: { select: { id: true, requestedById: true } } },
    },
});

// ── The prompt ───────────────────────────────────────────────────────────────

/**
 * Prompt the hiring manager for one interview if it is ready. Must run under
 * the tenant's context. Idempotent: a second call (or the job racing the
 * submit path) finds decisionPromptedAt set and prompts nothing.
 *
 * @returns {Promise<{ prompted: boolean, reason?: string, recommendationCounts?: object }>}
 */
export async function promptInterviewDecision({ tenantId, interviewId, now = new Date() } = {}) {
    const id = positiveInt(interviewId);
    if (!tenantId || !id) return { prompted: false, reason: "INVALID" };
    const at = new Date(now);

    const interview = await prisma.interview.findFirst({ where: withTenant(tenantId, { id }), select: PROMPT_SELECT });
    if (!interview) return { prompted: false, reason: "NOT_FOUND" };
    if (!isReadyForDecisionPrompt(interview, at)) return { prompted: false, reason: "NOT_READY" };

    // The consolidated view is the summary the prompt is about; only its
    // recommendation counts travel on the event.
    const summary = await consolidateInterviewFeedback({ id, tenantId });
    const recommendationCounts = summary?.recommendations ?? {};
    const requisition = interview.application?.jobRequisition;
    const hiringManager = hiringManagerEmployeeIdOf(requisition);

    return tenantTransaction(
        prisma,
        async (tx) => {
            const claim = await tx.interview.updateMany({
                where: { id, tenantId, decision: null, decisionPromptedAt: null },
                data: { decisionPromptedAt: at },
            });
            if (!claim.count) return { prompted: false, reason: "ALREADY_PROMPTED" };
            if (hiringManager) {
                await tx.interviewReminder.createMany({
                    data: [{
                        tenantId,
                        interviewId: id,
                        kind: REMINDER_KIND.DECISION_PROMPT,
                        recipientKey: employeeRecipientKey(hiringManager),
                        sentAt: at,
                    }],
                    skipDuplicates: true,
                });
            }
            await enqueueHrDomainEvent(
                tx,
                decisionPromptEvent(
                    {
                        tenantId,
                        interviewId: id,
                        applicationId: interview.applicationId,
                        requisitionId: requisition?.id ?? interview.application?.jobRequisitionId ?? null,
                        hiringManagerEmployeeId: hiringManager,
                        recommendationCounts,
                    },
                    eventContext({}),
                ),
            );
            return { prompted: true, recommendationCounts };
        },
        { tenantId },
    );
}

/**
 * The scorecard submit hook: prompt at once when the last panel scorecard
 * lands. Fail-soft: the scorecard is already saved, so a failure here is
 * logged and left to the job.
 */
export async function promptDecisionAfterScorecard({ tenantId, interviewId, now = new Date() } = {}) {
    if (!isRecruitmentFlagEnabled("decisionPrompts") || !tenantId) return { prompted: false, reason: "FLAG_OFF" };
    const run = async () => await promptInterviewDecision({ tenantId, interviewId, now });
    try {
        const store = mcpCtx.getStore();
        return store?.user?.tenantId === tenantId && !store?.system
            ? await run()
            : await mcpCtx.run({ user: { tenantId } }, run);
    } catch (err) {
        logger.warn(
            { component: COMPONENT, tenantId, interviewId, code: err?.code, errMessage: err?.message },
            "decision prompt after scorecard failed; the job will retry",
        );
        return { prompted: false, reason: "ERROR" };
    }
}

/**
 * Prompt every ready interview across tenants (the backstop for the submit
 * hook, and the path for interviews whose slot ends after the last scorecard).
 * Suggested cadence: every 15 minutes.
 *
 * @param {{ now?: Date, limit?: number }} [args]
 */
export async function runDecisionPromptJob({ now = new Date(), limit = DEFAULT_LIMIT } = {}) {
    if (!isRecruitmentFlagEnabled("decisionPrompts")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const take = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 1000);
    const summary = { scanned: 0, prompted: 0, notReady: 0, skipped: 0, failed: 0 };

    const rows = await mcpCtx.run({ system: true }, async () =>
        await prisma.interview.findMany({
            where: {
                tenantId: { not: null },
                status: { in: ["SCHEDULED", "COMPLETED"] },
                decision: null,
                decisionPromptedAt: null,
                scheduledAt: { gte: new Date(at.getTime() - PROMPT_LOOKBACK_MS), lte: at },
                interviewers: { some: {} },
            },
            select: PROMPT_SELECT,
            orderBy: [{ scheduledAt: "desc" }, { id: "desc" }],
            take,
        }),
    );
    summary.scanned = rows.length;

    for (const row of rows) {
        if (!isReadyForDecisionPrompt(row, at)) {
            summary.notReady += 1;
            continue;
        }
        try {
            const result = await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () =>
                await promptInterviewDecision({ tenantId: row.tenantId, interviewId: row.id, now: at }),
            );
            summary[result.prompted ? "prompted" : "skipped"] += 1;
        } catch (err) {
            summary.failed += 1;
            logger.warn(
                { component: COMPONENT, tenantId: row.tenantId, interviewId: row.id, code: err?.code, errMessage: err?.message },
                "decision prompt failed",
            );
        }
    }
    if (summary.scanned) logger.info({ component: COMPONENT, ...summary }, "decision prompt run");
    return summary;
}

// ── Auto-advance ─────────────────────────────────────────────────────────────

// The workflow's own refusals are thrown before it writes anything, so the
// caller's transaction (the decision) stays healthy and commits without a move.
const isWorkflowRefusal = (err) => err?.status === 409 && String(err?.code ?? "").startsWith("HR-RECRUITMENT-");

const none = (reason) => ({ action: "NONE", reason });

/**
 * Follow a recorded interview decision with the automatic application move.
 * Runs on the caller's transaction, after the decision was written, so the
 * decision and its consequence commit together. Callers: setInterviewOutcome
 * (interview-mgmt.service.js) and the hr_interview_update decision path
 * (interview.service.js).
 *
 * @param {object} tx  the caller's tenant transaction client
 * @param {{ tenantId:string, interviewId:number, decision:string, previousDecision?:string|null, actorId?:number|null, correlationId?:string }} args
 * @returns {Promise<{ action: "NONE"|"ADVANCED"|"NEXT_ROUND_REQUESTED", reason?: string, toStage?: string }>}
 */
export async function applyDecisionAutoAdvance(tx, { tenantId, interviewId, decision, previousDecision = null, actorId = null, correlationId } = {}) {
    if (!isRecruitmentFlagEnabled("decisionPrompts")) return none("FLAG_OFF");
    const normalized = String(decision ?? "").trim().toUpperCase();
    if (normalized === "REJECTED") return none("REJECTION_NEEDS_HUMAN_DISPOSITION");
    if (normalized !== "NEXT_ROUND") return none("NOT_NEXT_ROUND");
    if (String(previousDecision ?? "").toUpperCase() === "NEXT_ROUND") return none("UNCHANGED");
    const id = positiveInt(interviewId);
    if (!tenantId || !id) return none("NOT_FOUND");

    const interview = await tx.interview.findFirst({
        where: withTenant(tenantId, { id }),
        select: {
            id: true,
            applicationId: true,
            interviewType: true,
            application: { select: { id: true, stage: true, jobRequisitionId: true } },
        },
    });
    const application = interview?.application;
    if (!application) return none("NOT_FOUND");
    if (application.stage !== "interview") return none("STAGE_NOT_INTERVIEW");

    const otherRoundScheduled = await tx.interview.count({
        where: withTenant(tenantId, { applicationId: application.id, id: { not: id }, status: "SCHEDULED" }),
    });

    if (interview.interviewType === FINAL_ROUND_TYPE) {
        if (otherRoundScheduled) return none("ROUND_STILL_SCHEDULED");
        try {
            await transitionApplicationStage({
                id: application.id,
                tenantId,
                targetStage: "offer",
                reason: `Final-round interview ${id} decision: NEXT_ROUND`,
                actorId: null,
                source: AUTO_ADVANCE_SOURCE,
                db: tx,
            });
            return { action: "ADVANCED", toStage: "offer" };
        } catch (err) {
            if (!isWorkflowRefusal(err)) throw err;
            logger.info({ component: COMPONENT, tenantId, interviewId: id, code: err.code }, "auto-advance refused by the workflow; decision kept");
            return none(err.code);
        }
    }

    if (otherRoundScheduled) return none("NEXT_ROUND_ALREADY_SCHEDULED");
    await enqueueHrDomainEvent(
        tx,
        applicationNextRoundEvent(
            {
                tenantId,
                applicationId: application.id,
                requisitionId: application.jobRequisitionId,
                interviewId: id,
                interviewType: interview.interviewType,
            },
            eventContext({ actorId, correlationId }),
        ),
    );
    return { action: "NEXT_ROUND_REQUESTED" };
}

export default {
    isReadyForDecisionPrompt,
    promptInterviewDecision,
    promptDecisionAfterScorecard,
    runDecisionPromptJob,
    applyDecisionAutoAdvance,
};

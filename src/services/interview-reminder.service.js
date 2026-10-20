// src/services/interview-reminder.service.js
//
// Recruitment Phase 3a — interview reminders, feedback nudges, the escalation
// to the recruiter, and the no-show prompt (flag interviewReminders).
//
// The plan: "Reminders 24 hours and 1 hour before; feedback nudge 2 hours
// after; escalation to the recruiter after 24 hours without a scorecard."
// "A candidate reschedule request pauses reminders."
//
// The rules this file holds:
//
//   * ONE ROW PER SEND. Every reminder, nudge or prompt is one InterviewReminder
//     row, unique on (interviewId, kind, recipientKey). The row is inserted
//     FIRST, in the same transaction as its outbox event; a unique violation
//     (P2002) means another run already sent it, so the send is skipped. Two
//     overlapping runs therefore never announce the same reminder twice.
//   * WINDOWS, NOT THRESHOLDS. Each kind is due inside its own window and only
//     there, so a run that comes late never sends a stale message:
//         REMINDER_24H         1 h < start - now <= 24 h
//         REMINDER_1H          0   < start - now <= 1 h
//         FEEDBACK_NUDGE       end + nudgeHours      <= now < end + escalationHours
//         FEEDBACK_ESCALATION  end + escalationHours <= now < that + 7 days
//     Thirty minutes before the start only the 1 h reminder is due; the 24 h
//     one was missed and stays missed. Once escalation is due, the nudge is
//     superseded by it. The escalation closes after a week so switching the
//     flag on does not escalate last year's interviews.
//   * PAUSED MEANS SILENT. An interview with remindersPausedAt set (an open
//     candidate reschedule request) gets nothing until the pause is cleared.
//     A confirmed reschedule clears the time-based rows
//     (resetInterviewRemindersForReschedule) so the new slot is reminded.
//   * CANDIDATE CONTACT IS GATED. A candidate reminder passes the same DNC and
//     consent gate as every other candidate contact (read-only); a blocked
//     candidate is skipped and nothing is recorded, so the reminder goes out if
//     the block is lifted inside the window.
//   * IDS ONLY. The events name the interview, the kind and the recipient; the
//     Notification Hub and the candidate communications consumer resolve
//     addresses and copy.
//
// Recipients: each panelist whose assignment is not "declined" (recipientKey
// "emp:<employeeId>"), the candidate ("candidate"), and the requisition's
// recruiter ("recruiter": JobRequisition.recruiterId, else the requester).
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { withTenant } from "../lib/tenancy.js";
import { mcpCtx } from "../mcp/context.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { eventContext } from "../lib/event-context.util.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { assertCommunicationsAllowed } from "./candidatePrivacy.service.js";
import { getRecruitmentSettings, RECRUITMENT_SETTINGS_DEFAULTS } from "./recruitment-settings.service.js";

const COMPONENT = "interview-reminder";

export const REMINDER_KIND = Object.freeze({
    REMINDER_24H: "REMINDER_24H",
    REMINDER_1H: "REMINDER_1H",
    FEEDBACK_NUDGE: "FEEDBACK_NUDGE",
    FEEDBACK_ESCALATION: "FEEDBACK_ESCALATION",
    DECISION_PROMPT: "DECISION_PROMPT",
    NO_SHOW_PROMPT: "NO_SHOW_PROMPT",
});

export const RECIPIENT_TYPE = Object.freeze({
    CANDIDATE: "CANDIDATE",
    INTERVIEWER: "INTERVIEWER",
    RECRUITER: "RECRUITER",
});

export const INTERVIEW_REMINDER_EVENT = "hr.recruitment.interview_reminder.v1";
export const INTERVIEW_NO_SHOW_PROMPT_EVENT = "hr.recruitment.interview_no_show_prompt.v1";

export const CANDIDATE_RECIPIENT_KEY = "candidate";
export const RECRUITER_RECIPIENT_KEY = "recruiter";
export const employeeRecipientKey = (employeeId) => `emp:${employeeId}`;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const ESCALATION_WINDOW_HOURS = 7 * 24;
// How far back the feedback scan looks: the longest escalation setting (720 h,
// the settings CHECK), its window, and the longest interview (480 min).
const FEEDBACK_LOOKBACK_MS = (720 + ESCALATION_WINDOW_HOURS + 8) * HOUR_MS;
const NO_SHOW_LOOKBACK_MS = 14 * DAY_MS;
const DEFAULT_LIMIT = 200;

// The kinds a confirmed reschedule invalidates: they were computed from the
// old start and end. Prompts are about the panel's evidence, not the time.
const TIME_BOUND_KINDS = Object.freeze([
    REMINDER_KIND.REMINDER_24H,
    REMINDER_KIND.REMINDER_1H,
    REMINDER_KIND.FEEDBACK_NUDGE,
    REMINDER_KIND.FEEDBACK_ESCALATION,
]);

// The refusals of the candidate contact gate that mean "do not remind".
const CONTACT_BLOCKED_CODES = new Set([
    "HR-RECRUITMENT-DNC-BLOCKED",
    "HR-RECRUITMENT-CONSENT-WITHDRAWN",
    "HR-RECRUITMENT-CANDIDATE-NOT-FOUND",
    "HR-RECRUITMENT-CANDIDATE-REQUIRED",
]);

const isUniqueViolation = (err) => err?.code === "P2002";

const positiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const clampLimit = (limit) => Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 1000);

// ── Shared rules (the decision prompt and the workspaces use them too) ──────

/** Panel members who are expected to attend and score: not "declined". */
export const activePanel = (interview) =>
    (interview?.interviewers || [])
        .filter((link) => String(link?.status ?? "").toLowerCase() !== "declined")
        .map((link) => Number(link.employeeId ?? link.employee?.id))
        .filter((id) => Number.isInteger(id) && id > 0);

/** Panel members with no SUBMITTED scorecard (a draft is not evidence). */
export const missingScorecards = (interview) => {
    const submitted = new Set(
        (interview?.scorecards || []).filter((card) => card.submittedAt).map((card) => Number(card.reviewerId)),
    );
    return activePanel(interview).filter((id) => !submitted.has(id));
};

export const interviewEnd = (interview) =>
    new Date(new Date(interview.scheduledAt).getTime() + (Number(interview.durationMinutes) || 60) * 60 * 1000);

/** The recruiter a stalled panel escalates to: the requisition's recruiter, else its requester. */
export const recruiterEmployeeIdOf = (requisition) =>
    positiveInt(requisition?.recruiterId) ?? positiveInt(requisition?.requestedById);

/** The hiring manager who decides: the requisition's requester (the MANAGED scope's owner). */
export const hiringManagerEmployeeIdOf = (requisition) => positiveInt(requisition?.requestedById);

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * hr.recruitment.interview_reminder.v1 — ids and vocabulary only. Null when
 * the interview has no tenant (the enqueue then skips it, fail-closed).
 */
export function interviewReminderEvent(
    { tenantId, interviewId, applicationId, kind, recipientType, recipientEmployeeId = null },
    ctx = {},
) {
    if (!tenantId) return null;
    return {
        eventName: INTERVIEW_REMINDER_EVENT,
        tenantId,
        aggregateType: "Interview",
        aggregateId: interviewId,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            interviewId: String(interviewId),
            applicationId: applicationId != null ? String(applicationId) : null,
            kind,
            recipientType,
            ...(recipientEmployeeId != null ? { recipientEmployeeId: String(recipientEmployeeId) } : {}),
        },
    };
}

/** hr.recruitment.interview_no_show_prompt.v1 — the recruiter decides what a no-show means. */
export function interviewNoShowPromptEvent({ tenantId, interviewId, applicationId, requisitionId, recruiterEmployeeId }, ctx = {}) {
    if (!tenantId) return null;
    return {
        eventName: INTERVIEW_NO_SHOW_PROMPT_EVENT,
        tenantId,
        aggregateType: "Interview",
        aggregateId: interviewId,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        payload: {
            interviewId: String(interviewId),
            applicationId: applicationId != null ? String(applicationId) : null,
            requisitionId: requisitionId != null ? String(requisitionId) : null,
            recruiterEmployeeId: recruiterEmployeeId != null ? String(recruiterEmployeeId) : null,
        },
    };
}

// ── Planning (pure) ──────────────────────────────────────────────────────────

const hoursSetting = (settings, key) => {
    const n = Number(settings?.[key]);
    return Number.isFinite(n) && n >= 0 ? n : RECRUITMENT_SETTINGS_DEFAULTS[key];
};

function upcomingKind(interview, now) {
    if (interview.status !== "SCHEDULED") return null;
    const lead = new Date(interview.scheduledAt).getTime() - now.getTime();
    if (lead > HOUR_MS && lead <= DAY_MS) return REMINDER_KIND.REMINDER_24H;
    if (lead > 0 && lead <= HOUR_MS) return REMINDER_KIND.REMINDER_1H;
    return null;
}

function upcomingSends(interview, kind) {
    const sends = activePanel(interview).map((employeeId) => ({
        kind,
        recipientKey: employeeRecipientKey(employeeId),
        recipientType: RECIPIENT_TYPE.INTERVIEWER,
        recipientEmployeeId: employeeId,
    }));
    if (positiveInt(interview.application?.candidateId)) {
        sends.push({ kind, recipientKey: CANDIDATE_RECIPIENT_KEY, recipientType: RECIPIENT_TYPE.CANDIDATE });
    }
    return sends;
}

function feedbackSends(interview, now, settings) {
    if (!["SCHEDULED", "COMPLETED"].includes(interview.status) || interview.decision) return [];
    const end = interviewEnd(interview).getTime();
    const at = now.getTime();
    if (at < end) return [];
    const missing = missingScorecards(interview);
    if (!missing.length) return [];

    const nudgeAt = end + hoursSetting(settings, "feedbackNudgeHours") * HOUR_MS;
    const escalateAt = end + hoursSetting(settings, "feedbackEscalationHours") * HOUR_MS;
    if (at >= nudgeAt && at < escalateAt) {
        return missing.map((employeeId) => ({
            kind: REMINDER_KIND.FEEDBACK_NUDGE,
            recipientKey: employeeRecipientKey(employeeId),
            recipientType: RECIPIENT_TYPE.INTERVIEWER,
            recipientEmployeeId: employeeId,
        }));
    }
    const recruiter = recruiterEmployeeIdOf(interview.application?.jobRequisition);
    if (at >= escalateAt && at < escalateAt + ESCALATION_WINDOW_HOURS * HOUR_MS && recruiter) {
        return [{
            kind: REMINDER_KIND.FEEDBACK_ESCALATION,
            recipientKey: RECRUITER_RECIPIENT_KEY,
            recipientType: RECIPIENT_TYPE.RECRUITER,
            recipientEmployeeId: recruiter,
        }];
    }
    return [];
}

/**
 * Which reminders are due for one interview right now. Pure: the interview
 * graph (status, decision, scheduledAt, durationMinutes, remindersPausedAt,
 * interviewers, scorecards, application.candidateId and its requisition's
 * recruiterId/requestedById) and the tenant settings in, the due sends out.
 * Already-sent rows are not considered here; the unique row decides.
 *
 * @returns {{ kind:string, recipientKey:string, recipientType:string, recipientEmployeeId?:number }[]}
 */
export function planInterviewReminders(interview, { now = new Date(), settings = RECRUITMENT_SETTINGS_DEFAULTS } = {}) {
    if (!interview || interview.remindersPausedAt) return [];
    const at = new Date(now);
    const kind = upcomingKind(interview, at);
    return [...(kind ? upcomingSends(interview, kind) : []), ...feedbackSends(interview, at, settings)];
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** True when the candidate may be contacted (read-only DNC and consent gate). */
async function candidateContactAllowed(tx, { tenantId, candidateId, now }) {
    try {
        await assertCommunicationsAllowed({ tenantId, candidateId, purpose: "PROCESSING", at: now }, { db: tx });
        return true;
    } catch (err) {
        if (CONTACT_BLOCKED_CODES.has(err?.code)) return false;
        throw err;
    }
}

/**
 * Record one send and enqueue its event in one tenant transaction. The row is
 * inserted first: a P2002 rolls the transaction back and reads "duplicate".
 * @returns {Promise<"sent"|"duplicate"|"blocked">}
 */
async function sendOne(interview, send, now) {
    const tenantId = interview.tenantId;
    try {
        return await tenantTransaction(
            prisma,
            async (tx) => {
                if (send.recipientType === RECIPIENT_TYPE.CANDIDATE) {
                    const allowed = await candidateContactAllowed(tx, {
                        tenantId,
                        candidateId: interview.application.candidateId,
                        now,
                    });
                    if (!allowed) return "blocked";
                }
                await tx.interviewReminder.create({
                    data: { tenantId, interviewId: interview.id, kind: send.kind, recipientKey: send.recipientKey, sentAt: now },
                });
                await enqueueHrDomainEvent(
                    tx,
                    interviewReminderEvent(
                        {
                            tenantId,
                            interviewId: interview.id,
                            applicationId: interview.applicationId,
                            kind: send.kind,
                            recipientType: send.recipientType,
                            recipientEmployeeId: send.recipientEmployeeId ?? null,
                        },
                        eventContext({}),
                    ),
                );
                return "sent";
            },
            { tenantId },
        );
    } catch (err) {
        if (isUniqueViolation(err)) return "duplicate";
        throw err;
    }
}

const sentKey = (kind, recipientKey) => `${kind}|${recipientKey}`;

/** Plan and send one interview's due reminders (tenant context active). */
async function remindOne(interview, { now, settings, summary }) {
    const due = planInterviewReminders(interview, { now, settings });
    if (!due.length) return;
    // One cheap read skips what is already recorded without opening a
    // transaction per send; the unique row still decides any race.
    const existing = await prisma.interviewReminder.findMany({
        where: withTenant(interview.tenantId, { interviewId: interview.id }),
        select: { kind: true, recipientKey: true },
    });
    const done = new Set(existing.map((row) => sentKey(row.kind, row.recipientKey)));
    for (const send of due) {
        if (done.has(sentKey(send.kind, send.recipientKey))) {
            summary.duplicate += 1;
            continue;
        }
        const outcome = await sendOne(interview, send, now);
        summary[outcome] += 1;
    }
}

const SCAN_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    applicationId: true,
    status: true,
    decision: true,
    scheduledAt: true,
    durationMinutes: true,
    remindersPausedAt: true,
    interviewers: { select: { employeeId: true, status: true } },
    scorecards: { select: { reviewerId: true, submittedAt: true } },
    application: {
        select: {
            candidateId: true,
            jobRequisitionId: true,
            jobRequisition: { select: { id: true, recruiterId: true, requestedById: true } },
        },
    },
});

/** The interviews that may have something due, read across tenants. */
async function scanReminderCandidates(at, take) {
    return mcpCtx.run({ system: true }, async () => {
        const upcoming = await prisma.interview.findMany({
            where: {
                tenantId: { not: null },
                status: "SCHEDULED",
                remindersPausedAt: null,
                scheduledAt: { gt: at, lte: new Date(at.getTime() + DAY_MS) },
            },
            select: SCAN_SELECT,
            orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
            take,
        });
        // Newest first: the interviews in their nudge window matter most. An
        // escalated interview has nothing left to send.
        const finished = await prisma.interview.findMany({
            where: {
                tenantId: { not: null },
                status: { in: ["SCHEDULED", "COMPLETED"] },
                decision: null,
                remindersPausedAt: null,
                scheduledAt: { gte: new Date(at.getTime() - FEEDBACK_LOOKBACK_MS), lte: at },
                reminders: { none: { kind: REMINDER_KIND.FEEDBACK_ESCALATION } },
            },
            select: SCAN_SELECT,
            orderBy: [{ scheduledAt: "desc" }, { id: "desc" }],
            take,
        });
        return [...upcoming, ...finished];
    });
}

const groupByTenant = (rows) =>
    rows.reduce((map, row) => {
        if (!map.has(row.tenantId)) map.set(row.tenantId, []);
        map.get(row.tenantId).push(row);
        return map;
    }, new Map());

/**
 * Send every due interview reminder, feedback nudge and escalation across
 * tenants, then the no-show prompts. Suggested cadence: every 15 minutes.
 *
 * @param {{ now?: Date, limit?: number }} [args]
 */
export async function runInterviewReminderJob({ now = new Date(), limit = DEFAULT_LIMIT } = {}) {
    if (!isRecruitmentFlagEnabled("interviewReminders")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const summary = { scanned: 0, sent: 0, duplicate: 0, blocked: 0, failed: 0 };

    const rows = await scanReminderCandidates(at, clampLimit(limit));
    summary.scanned = rows.length;

    for (const [tenantId, interviews] of groupByTenant(rows)) {
        await mcpCtx.run({ user: { tenantId } }, async () => {
            let settings;
            try {
                settings = await getRecruitmentSettings({ tenantId });
            } catch (err) {
                logger.warn({ component: COMPONENT, tenantId, errMessage: err?.message }, "interview reminders: settings unavailable, tenant skipped");
                summary.failed += interviews.length;
                return;
            }
            for (const interview of interviews) {
                try {
                    await remindOne(interview, { now: at, settings, summary });
                } catch (err) {
                    // One bad interview never stops the run.
                    summary.failed += 1;
                    logger.warn(
                        { component: COMPONENT, tenantId, interviewId: interview.id, code: err?.code, errMessage: err?.message },
                        "interview reminder failed",
                    );
                }
            }
        });
    }

    const noShow = await runInterviewNoShowPromptJob({ now: at, limit });
    if (summary.scanned) logger.info({ component: COMPONENT, ...summary }, "interview reminder run");
    return { ...summary, noShow };
}

// ── No-show prompt ───────────────────────────────────────────────────────────

/** Prompt the recruiter once about one no-show (tenant context active). */
async function promptNoShow(interview, now) {
    const requisition = interview.application?.jobRequisition;
    const recruiter = recruiterEmployeeIdOf(requisition);
    try {
        await tenantTransaction(
            prisma,
            async (tx) => {
                await tx.interviewReminder.create({
                    data: {
                        tenantId: interview.tenantId,
                        interviewId: interview.id,
                        kind: REMINDER_KIND.NO_SHOW_PROMPT,
                        recipientKey: RECRUITER_RECIPIENT_KEY,
                        sentAt: now,
                    },
                });
                await enqueueHrDomainEvent(
                    tx,
                    interviewNoShowPromptEvent(
                        {
                            tenantId: interview.tenantId,
                            interviewId: interview.id,
                            applicationId: interview.applicationId,
                            requisitionId: requisition?.id ?? interview.application?.jobRequisitionId ?? null,
                            recruiterEmployeeId: recruiter,
                        },
                        eventContext({}),
                    ),
                );
            },
            { tenantId: interview.tenantId },
        );
        return "prompted";
    } catch (err) {
        if (isUniqueViolation(err)) return "duplicate";
        throw err;
    }
}

/**
 * Prompt the recruiter about every recent NO_SHOW interview that has not been
 * prompted yet (one NO_SHOW_PROMPT row each). Runs inside the reminder job.
 *
 * @param {{ now?: Date, limit?: number }} [args]
 */
export async function runInterviewNoShowPromptJob({ now = new Date(), limit = DEFAULT_LIMIT } = {}) {
    if (!isRecruitmentFlagEnabled("interviewReminders")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const summary = { scanned: 0, prompted: 0, duplicate: 0, failed: 0 };
    const rows = await mcpCtx.run({ system: true }, async () =>
        await prisma.interview.findMany({
            where: {
                tenantId: { not: null },
                status: "NO_SHOW",
                // Recent by when it was marked; a legacy row without the stamp
                // by its slot.
                OR: [
                    { noShowAt: { gte: new Date(at.getTime() - NO_SHOW_LOOKBACK_MS) } },
                    { noShowAt: null, scheduledAt: { gte: new Date(at.getTime() - NO_SHOW_LOOKBACK_MS) } },
                ],
                reminders: { none: { kind: REMINDER_KIND.NO_SHOW_PROMPT } },
            },
            select: {
                id: true,
                tenantId: true,
                applicationId: true,
                application: {
                    select: { jobRequisitionId: true, jobRequisition: { select: { id: true, recruiterId: true, requestedById: true } } },
                },
            },
            orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
            take: clampLimit(limit),
        }),
    );
    summary.scanned = rows.length;
    for (const interview of rows) {
        try {
            const outcome = await mcpCtx.run({ user: { tenantId: interview.tenantId } }, async () => await promptNoShow(interview, at));
            summary[outcome] += 1;
        } catch (err) {
            summary.failed += 1;
            logger.warn(
                { component: COMPONENT, tenantId: interview.tenantId, interviewId: interview.id, code: err?.code, errMessage: err?.message },
                "no-show prompt failed",
            );
        }
    }
    return summary;
}

// ── Reschedule hook ──────────────────────────────────────────────────────────

/**
 * A confirmed reschedule moves the start and end, so the time-bound reminder
 * rows of the old slot no longer say anything; clearing them lets the new slot
 * be reminded. Runs on the caller's transaction (interviewSchedule's
 * confirmReschedule). Prompts are kept.
 * @returns {Promise<number>} rows cleared
 */
export async function resetInterviewRemindersForReschedule(tx, { tenantId, interviewId } = {}) {
    const id = positiveInt(interviewId);
    if (!tenantId || !id) return 0;
    const { count } = await tx.interviewReminder.deleteMany({
        where: withTenant(tenantId, { interviewId: id, kind: { in: [...TIME_BOUND_KINDS] } }),
    });
    return count;
}

export default {
    planInterviewReminders,
    runInterviewReminderJob,
    runInterviewNoShowPromptJob,
    resetInterviewRemindersForReschedule,
};

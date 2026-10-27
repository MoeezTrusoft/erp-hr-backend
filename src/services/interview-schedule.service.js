// src/services/interview-schedule.service.js
//
// Phase 7 / decision record §5.1–5.4 — interview scheduling lifecycle.
//
// Shape of the module:
//
//   * §5.4 — cancel and reschedule are CODED, attributable, append-only facts
//     (InterviewLifecycleEvent). A reschedule keeps ONE interview and moves
//     its time — it does not create a second panel — because the alternative
//     forks scorecards, packets and the interviewers' assignments.
//   * §5.3 — a candidate's reschedule REQUEST is recorded as its own event and
//     routed to the recruiter. The recruiter owns the confirmation.
//   * §5.3a — the PANEL is notified only when the replacement schedule is
//     confirmed (interviewRescheduledEvent fires on confirmReschedule only,
//     never on the request), so a pending negotiation causes no calendar churn.
//   * §5.2/5.2a — confirming a schedule checks each interviewer: APPROVED leave
//     = hard block (refused, never overridable); non-working-day = warning the
//     caller may pass an authorized override + required reason past.
//   * §5.1a/5.1b — the calendar linkage records WHICH external event an
//     interview maps to and its sync state. Recruitment never calls a provider
//     directly (§5.1) — the Communication calendar-sync boundary consumes the
//     domain events and writes back through markCalendarSync.
//   * Recruitment Phase 3a — every change a calendar must hear about (create,
//     a move, a cancel, a no-show) MARKS the interview for the calendar sync
//     worker in the same transaction as the change (calendarSyncMark): status
//     PENDING, the action the worker must take, attempts reset, due now. The
//     worker (interview-calendar-sync.service.js) does the provider call
//     through the Communication module. Marking happens whether or not the
//     calendarSync flag is on, so switching it on later syncs what changed.
//   * Phase 3a — a reschedule REQUEST pauses the interview's reminders
//     (remindersPausedAt); the confirm and a cancel clear the pause.
//   * Phase 3a — NO_SHOW: a SCHEDULED interview whose start has passed can be
//     marked no-show; it records a NO_SHOW lifecycle event, cancels the
//     calendar event and announces hr.recruitment.interview_no_show.v1 so the
//     disposition prompt and the Communication module can react.
//   * Recruitment Phase 7 (B18a) — "non-working day" is the interviewer's
//     weekday in the TENANT's time zone (TenantRecruitmentSettings.timeZone,
//     the zone the slot finder already works in), not in UTC: a Friday 23:30
//     UTC slot is a Saturday in Asia/Karachi.
//   * Recruitment Phase 7 (B5) — each panelist may carry a panel role
//     (TECHNICAL | HIRING_MANAGER | HR | CULTURE) that decides which form
//     sections they rate. It is set when the interview is scheduled and may be
//     changed until the interview starts (setInterviewPanelRoles). No role =
//     every section (the behaviour before roles existed). Flag evaluationForms.

import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { logAction } from "../utils/logs.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import {
    interviewCancelledEvent,
    interviewRescheduledEvent,
    interviewRescheduleRequestedEvent,
    interviewUpdatedEvent,
} from "./hrEvents.js";
import {
    LIFECYCLE_EVENTS,
    RESCHEDULE_REASONS,
    blockedInterviewers,
    validateConflictOverride,
    validateLifecycleReason,
} from "../lib/interview-scheduling.util.js";
import { RECRUITMENT_SCOPE, interviewScopeWhere } from "../lib/recruitment-access.util.js";
import { isValidTimeZone, weekdayOf, zonedDate } from "../lib/slot-finder.util.js";
import { PANEL_ROLES } from "../lib/evaluation-form.util.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { employeeNamesById, nameOf } from "../lib/employee-names.util.js";
import logger from "../lib/logger.js";

export class ScheduleError extends Error {
    constructor(message, status = 400, details = undefined) {
        super(message);
        this.name = "ScheduleError";
        this.status = status;
        this.details = details;
    }
}

const fail = (message, status, details) => new ScheduleError(message, status, details);

const toInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const toDate = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

const AUDIT_MODULE = "Interview Scheduling";

// A ScheduleError that also carries the code on `.code` (the Phase 3a shape)
// while keeping `.details` for callers of the older paths.
const failCode = (message, status, code) => Object.assign(new ScheduleError(message, status, code), { code });

// ── Phase 3a — lifecycle vocabulary and calendar sync marking ───────────────

/**
 * The lifecycle event kinds this service writes. NO_SHOW is new in Phase 3a
 * and is not yet in lib/interview-scheduling.util.js's LIFECYCLE_EVENTS nor in the
 * interview_lifecycle_events_eventtype_check constraint (see the stream A
 * integration note for the migration).
 */
export const INTERVIEW_LIFECYCLE_EVENTS = Object.freeze([...new Set([...LIFECYCLE_EVENTS, "NO_SHOW"])]);

/** The reason code a NO_SHOW lifecycle row carries (also needs the CHECK change). */
export const NO_SHOW_REASON_CODE = "CANDIDATE_NO_SHOW";

export const CALENDAR_SYNC_ACTION = Object.freeze({ CREATE: "CREATE", UPDATE: "UPDATE", CANCEL: "CANCEL" });
export const CALENDAR_SYNC_STATUS = Object.freeze({ PENDING: "PENDING", SYNCED: "SYNCED", FAILED: "FAILED" });

/** What the calendar must do next: cancel, or update an event it already has, or create one. */
export function nextCalendarAction({ calendarEventId = null, cancel = false } = {}) {
    if (cancel) return CALENDAR_SYNC_ACTION.CANCEL;
    return calendarEventId ? CALENDAR_SYNC_ACTION.UPDATE : CALENDAR_SYNC_ACTION.CREATE;
}

/**
 * The column data that queues an interview for the calendar sync worker:
 * PENDING, the action, attempts reset, due now, no error. A claim a worker
 * holds is left alone: the new calendarNextAttemptAt tells that worker the
 * row changed under its call (it keeps the event id it got, releases the
 * claim and leaves the newer mark for the next pass), and no second worker
 * can start on the row while the first call is still in flight.
 */
// Loaded lazily: the reminder service pulls in the settings, privacy and
// prisma graph, which the schedule paths (and their callers) otherwise never
// need at import time.
const loadReminders = () => import("./interview-reminder.service.js");

/**
 * Phase 3a (stream B) — drop the time-bound reminder rows of a slot that
 * moved, so the new time is reminded afresh. Runs on the caller's
 * transaction. A client without the interview_reminders model (an older
 * unit-test double) has no rows to drop, so it is skipped rather than failed.
 */
export async function resetRemindersForReschedule(tx, { tenantId, interviewId }) {
    if (typeof tx?.interviewReminder?.deleteMany !== "function") return 0;
    const { resetInterviewRemindersForReschedule } = await loadReminders();
    return resetInterviewRemindersForReschedule(tx, { tenantId, interviewId });
}

export function calendarSyncMark(action, now = new Date()) {
    return {
        calendarSyncStatus: CALENDAR_SYNC_STATUS.PENDING,
        calendarSyncAction: action,
        calendarSyncAttempts: 0,
        calendarNextAttemptAt: new Date(now),
        calendarLastError: null,
    };
}

/**
 * hr.recruitment.interview_no_show.v1 — ids only. recruiterId routes the
 * disposition prompt; interviewerIds lets the panel's calendars and reminders
 * be told. Null when the interview has no tenant.
 */
export function interviewNoShowEvent(interview, ctx = {}, extra = {}) {
    if (!interview?.tenantId) return null;
    const str = (v) => (v != null ? String(v) : null);
    return {
        eventName: "hr.recruitment.interview_no_show.v1",
        tenantId: interview.tenantId,
        aggregateType: "Interview",
        aggregateId: interview.id,
        actorId: ctx?.actorId ?? null,
        correlationId: ctx?.correlationId,
        payload: {
            interviewId: String(interview.id),
            applicationId: str(interview.applicationId),
            candidateId: str(interview.candidateId),
            requisitionId: str(interview.requisitionId),
            recruiterId: str(extra.recruiterId),
            scheduledAt: interview.scheduledAt ? new Date(interview.scheduledAt).toISOString() : null,
            noShowAt: extra.noShowAt ? new Date(extra.noShowAt).toISOString() : null,
            interviewerIds: (extra.interviewerIds ?? []).map(String),
        },
    };
}

/** The tenant's interview with its panel ids — the event routing list. */
async function requireInterview(interviewId, tenantId) {
    const id = toInt(interviewId);
    if (!id) throw fail("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND");
    const interview = await prisma.interview.findFirst({
        where: scopedWhere(tenantId, { id }),
        select: {
            id: true,
            tenantId: true,
            applicationId: true,
            scheduledAt: true,
            status: true,
            durationMinutes: true,
            calendarEventId: true,
            calendarProvider: true,
            calendarSyncStatus: true,
            interviewers: { select: { employeeId: true } },
            application: { select: { id: true, candidateId: true } },
        },
    });
    if (!interview) throw fail("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND");
    return { ...interview, interviewerIds: interview.interviewers.map((i) => i.employeeId) };
}

function assertNotTerminal(interview) {
    if (interview.status === "CANCELLED") {
        throw fail("Interview is already cancelled", 409, "HR-RECRUITMENT-SCHEDULE-ALREADY-CANCELLED");
    }
    if (interview.status === "COMPLETED") {
        throw fail("A completed interview cannot be cancelled or rescheduled", 409, "HR-RECRUITMENT-SCHEDULE-COMPLETED");
    }
}

// ── §5.4 — cancel ────────────────────────────────────────────────────────────

/**
 * Cancel an interview with a mandatory coded reason (§5.4).
 * @param {object} p
 * @param {string} p.reasonCode  one of RESCHEDULE_REASONS
 * @param {string|null} p.notes  required when reasonCode is OTHER
 */
export const cancelInterview = async ({ interviewId, reasonCode, notes, tenantId, actorId, db = null }) => {
    const reason = validateLifecycleReason({ reasonCode, notes });
    if (!reason.ok) throw fail(reason.error, 400, { code: "HR-RECRUITMENT-SCHEDULE-REASON-INVALID" });

    // Phase 3b — a test release composes the cancel into its own transaction,
    // so the cancel and the rejection commit or roll back together.
    const inTx = (fn) => (db ? fn(db) : tenantTransaction(prisma, fn));
    return inTx(async (tx) => {
        const id = toInt(interviewId);
        const interview = await tx.interview.findFirst({
            where: scopedWhere(tenantId, { id: id ?? 0 }),
            select: {
                id: true, tenantId: true, applicationId: true, scheduledAt: true, status: true,
                interviewers: { select: { employeeId: true } },
                application: { select: { candidateId: true } },
            },
        });
        if (!interview) throw fail("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND");
        assertNotTerminal(interview);

        const interviewerIds = interview.interviewers.map((i) => i.employeeId);

        await tx.interview.update({
            where: { id: interview.id },
            data: { status: "CANCELLED" },
        });
        // Phase 3a — the calendar event goes too, and any reminder pause ends
        // with the interview. Same transaction as the cancel.
        await tx.interview.update({
            where: { id: interview.id },
            data: { ...calendarSyncMark(CALENDAR_SYNC_ACTION.CANCEL), remindersPausedAt: null },
        });
        await tx.interviewLifecycleEvent.create({
            data: scopedData(tenantId, {
                interviewId: interview.id,
                eventType: "CANCELLED",
                reasonCode: reason.code,
                notes: reason.notes,
                previousScheduledAt: interview.scheduledAt,
                actorId: toInt(actorId),
            }),
        });
        await enqueueHrDomainEvent(
            tx,
            interviewCancelledEvent(
                { ...interview, candidateId: interview.application?.candidateId ?? null },
                { actorId: toInt(actorId) ?? null },
                { reasonCode: reason.code, interviewerIds },
            ),
        );
        await logAction({
            employeeId: toInt(actorId) ?? null,
            type: "UPDATE",
            module: AUDIT_MODULE,
            result: "SUCCESS",
            notes: `Interview "${interview.id}" cancelled (${reason.code})`,
            tenantId: tenantId ?? null,
        });
        return { interviewId: interview.id, status: "CANCELLED", reasonCode: reason.code };
    });
};

// ── §5.2/5.2a — availability checks over the REAL HR data ────────────────────

// The zone a tenant without a settings row works in: the column default of
// TenantRecruitmentSettings.timeZone and RECRUITMENT_SETTINGS_DEFAULTS.timeZone
// (a test pins the three together). Not imported from the settings service so
// the schedule paths stay free of its import graph.
export const DEFAULT_TENANT_TIME_ZONE = "Asia/Karachi";

const WEEKDAY_KEYS = Object.freeze(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);

/**
 * B18a — the time zone a tenant's working days are counted in: its recruitment
 * settings' zone, else the default. A client without the settings model (an
 * older unit-test double) keeps the pre-Phase-7 UTC rule; a failed read is
 * logged and answers the default rather than failing the schedule.
 */
export async function tenantScheduleTimeZone(db, tenantId) {
    if (typeof db?.tenantRecruitmentSettings?.findFirst !== "function") return "UTC";
    if (!tenantId) return DEFAULT_TENANT_TIME_ZONE;
    try {
        const row = await db.tenantRecruitmentSettings.findFirst({ where: { tenantId }, select: { timeZone: true } });
        const zone = row?.timeZone ?? DEFAULT_TENANT_TIME_ZONE;
        if (isValidTimeZone(zone)) return zone;
        logger.warn({ tenantId }, "interview availability: the tenant time zone is not valid, using the default");
    } catch (err) {
        logger.warn({ err: err?.message, tenantId }, "interview availability: could not read the tenant time zone, using the default");
    }
    return DEFAULT_TENANT_TIME_ZONE;
}

/** The schedule_pattern key ("monday".."sunday") of an instant's date in a zone. */
export function weekdayKeyInZone(instant, timeZone = "UTC") {
    return WEEKDAY_KEYS[weekdayOf(zonedDate(instant, timeZone))];
}

/**
 * Which of these interviewers' effective work schedule marks the slot's
 * (tenant-local) weekday off? schedule_pattern follows the weekly map the
 * attendance and overtime services read (monday..sunday, ""/absent = off).
 * No schedule at all cannot claim a conflict: the WARNING tier fails open (a
 * hard block needs evidence).
 */
async function nonWorkingInterviewers(db, { tenantId, ids, start, timeZone }) {
    if (!ids.length) return [];
    const dayKey = weekdayKeyInZone(start, timeZone);
    const schedules = await db.workSchedule.findMany({
        where: scopedWhere(tenantId, {
            employeeId: { in: ids },
            effective_start_date: { lte: start },
            OR: [{ effective_end_date: null }, { effective_end_date: { gte: start } }],
        }),
        orderBy: { effective_start_date: "desc" },
        select: { employeeId: true, schedule_pattern: true },
    });
    const patternByEmployee = new Map();
    for (const s of schedules) {
        if (!patternByEmployee.has(s.employeeId)) patternByEmployee.set(s.employeeId, s.schedule_pattern);
    }
    return ids.filter((id) => {
        const pattern = patternByEmployee.get(id);
        if (!pattern || typeof pattern !== "object") return false;
        const timing = pattern[dayKey];
        return !(typeof timing === "string" && timing.trim() !== "");
    });
}

/**
 * Which of these interviewers are on APPROVED leave overlapping the slot, and
 * whose effective schedule marks the date non-working? §5.2 says check HR
 * attendance/leave/work schedule; §5.2a fixes the tiers.
 *
 * @returns {{ blocked: number[], nonWorkingDay: number[], timeZone: string }}
 */
export const checkInterviewerAvailability = async ({ scheduledAt, durationMinutes = 60, interviewerIds, tenantId }) => {
    const start = toDate(scheduledAt);
    if (!start) throw fail("scheduledAt must be a valid ISO 8601 datetime", 400);
    const end = new Date(start.getTime() + Number(durationMinutes || 60) * 60000);
    const ids = (interviewerIds ?? []).map(toInt).filter(Boolean);
    const timeZone = await tenantScheduleTimeZone(prisma, tenantId);
    if (!ids.length) return { blocked: [], nonWorkingDay: [], timeZone };

    // §5.2 — APPROVED leave only: a pending request is not yet a fact, a
    // rejected one never was. Leave rows are day-granular; the overlap rule
    // lives in the lib (leaveOverlapsSlot) so the semantics exist once.
    const leaveRows = await prisma.leaveRequest.findMany({
        where: scopedWhere(tenantId, {
            employeeId: { in: ids },
            status: "APPROVED",
        }),
        select: { employeeId: true, startDate: true, endDate: true },
    });
    const blocked = blockedInterviewers(start, end, leaveRows);
    const nonWorkingDay = await nonWorkingInterviewers(prisma, { tenantId, ids, start, timeZone });

    return { blocked, nonWorkingDay, timeZone };
};

// ── §5.3/5.3a — reschedule request → recruiter confirms ─────────────────────

/**
 * A candidate requests a reschedule (§5.3). Recorded as RESCHEDULE_REQUESTED
 * with the coded reason (the §5.4 vocabulary applies — CANDIDATE_REQUEST is
 * the expected code); NO panel event fires here (§5.3a). The requested time is
 * stored on the event row for the recruiter to confirm against.
 */
export const requestReschedule = async ({ interviewId, reasonCode, notes, requestedFor, tenantId, actorId }) => {
    const reason = validateLifecycleReason({ reasonCode, notes, allowed: RESCHEDULE_REASONS });
    if (!reason.ok) throw fail(reason.error, 400, { code: "HR-RECRUITMENT-SCHEDULE-REASON-INVALID" });
    const when = requestedFor ? toDate(requestedFor) : null;
    if (requestedFor && !when) throw fail("requestedFor must be a valid ISO 8601 datetime", 400);

    return tenantTransaction(prisma, async (tx) => {
        const id = toInt(interviewId);
        const interview = await tx.interview.findFirst({
            where: scopedWhere(tenantId, { id: id ?? 0 }),
            select: {
                id: true, tenantId: true, applicationId: true, scheduledAt: true, status: true,
                application: {
                    select: {
                        candidateId: true,
                        jobRequisition: { select: { requestedById: true } },
                    },
                },
            },
        });
        if (!interview) throw fail("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND");
        assertNotTerminal(interview);

        // §5.3 — the recruiter who owns the confirmation is the requisition's
        // requestedBy; the event routes to them, never to the panel.
        const recruiterId = interview.application?.jobRequisition?.requestedById ?? null;

        // Phase 3a — no reminder for a time the candidate has asked to move.
        await tx.interview.update({
            where: { id: interview.id },
            data: { remindersPausedAt: new Date() },
        });

        const event = await tx.interviewLifecycleEvent.create({
            data: scopedData(tenantId, {
                interviewId: interview.id,
                eventType: "RESCHEDULE_REQUESTED",
                reasonCode: reason.code,
                notes: reason.notes,
                previousScheduledAt: interview.scheduledAt,
                newScheduledAt: when,
                actorId: toInt(actorId),
            }),
        });
        // §5.3a — recruiter-routed only: no interviewerIds in the payload, so a
        // consumer CANNOT fan out to the panel even by mistake.
        await enqueueHrDomainEvent(
            tx,
            interviewRescheduleRequestedEvent(
                { ...interview, candidateId: interview.application?.candidateId ?? null },
                { actorId: toInt(actorId) ?? null },
                { requestedFor: when ? when.toISOString() : null, note: reason.notes, recruiterId },
            ),
        );
        await logAction({
            employeeId: toInt(actorId) ?? null,
            type: "CREATE",
            module: AUDIT_MODULE,
            result: "SUCCESS",
            notes: `Reschedule requested on interview "${interview.id}" (${reason.code})`,
            tenantId: tenantId ?? null,
        });
        return { eventId: event.id, interviewId: interview.id, requestedFor: when ? when.toISOString() : null };
    });
};

/**
 * Confirm a replacement schedule (§5.3 — "the recruiter owns final
 * confirmation"). §5.2a availability runs FIRST: an approved-leave conflict is
 * refused outright; a non-working-day conflict requires an authorized
 * override + reason. The interview's time moves and — only here — the panel
 * event fires (§5.3a).
 */
export const confirmReschedule = async ({ interviewId, scheduledAt, reasonCode, notes, override, overrideReason, tenantId, actorId }) => {
    const reason = validateLifecycleReason({ reasonCode, notes, allowed: RESCHEDULE_REASONS });
    if (!reason.ok) throw fail(reason.error, 400, { code: "HR-RECRUITMENT-SCHEDULE-REASON-INVALID" });
    const when = toDate(scheduledAt);
    if (!when) throw fail("scheduledAt must be a valid ISO 8601 datetime", 400);

    return tenantTransaction(prisma, async (tx) => {
        const id = toInt(interviewId);
        const interview = await tx.interview.findFirst({
            where: scopedWhere(tenantId, { id: id ?? 0 }),
            select: {
                id: true, tenantId: true, applicationId: true, scheduledAt: true, status: true, durationMinutes: true,
                calendarEventId: true,
                interviewers: { select: { employeeId: true } },
                application: { select: { candidateId: true } },
            },
        });
        if (!interview) throw fail("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND");
        assertNotTerminal(interview);

        const interviewerIds = interview.interviewers.map((i) => i.employeeId);

        // §5.2/5.2a — availability gate on the NEW time, against real leave and
        // schedule data. Reads happen inside the tx for consistency.
        const end = new Date(when.getTime() + Number(interview.durationMinutes || 60) * 60000);
        const leaveRows = interviewerIds.length
            ? await tx.leaveRequest.findMany({
                where: scopedWhere(tenantId, { employeeId: { in: interviewerIds }, status: "APPROVED" }),
                select: { employeeId: true, startDate: true, endDate: true },
            })
            : [];
        const blocked = blockedInterviewers(when, end, leaveRows);

        // B18a — the weekday is the tenant's, not UTC's.
        const timeZone = await tenantScheduleTimeZone(tx, tenantId);
        const nonWorkingDay = await nonWorkingInterviewers(tx, { tenantId, ids: interviewerIds, start: when, timeZone });

        if (blocked.length) {
            // §5.2a — HARD BLOCK. No override exists for approved leave.
            throw fail("Interviewer(s) on approved leave for the proposed slot", 409, {
                code: "HR-RECRUITMENT-SCHEDULE-LEAVE-BLOCK",
                blockedInterviewerIds: blocked,
            });
        }
        if (nonWorkingDay.length) {
            // §5.2a — the WARNING tier still requires a HUMAN decision: proceed
            // only with an authorized override + required reason. A detected
            // conflict with no override refuses; an override without a reason
            // refuses. (The lib cannot know a conflict exists — the service
            // owns that call.)
            if (!override) {
                throw fail("Interviewer(s) outside their work schedule for the proposed slot", 400, {
                    code: "HR-RECRUITMENT-SCHEDULE-OVERRIDE-REASON-REQUIRED",
                    nonWorkingDayInterviewerIds: nonWorkingDay,
                });
            }
            const verdict = validateConflictOverride({ hasBlocked: false, override: true, overrideReason });
            if (!verdict.ok) throw fail(verdict.error, 400, { code: "HR-RECRUITMENT-SCHEDULE-OVERRIDE-REASON-REQUIRED" });
            await logAction({
                employeeId: toInt(actorId) ?? null,
                type: "UPDATE",
                module: AUDIT_MODULE,
                result: "SUCCESS",
                notes: `Non-working-day conflict overridden on interview "${interview.id}": ${verdict.reason}`,
                tenantId: tenantId ?? null,
            });
        }

        const previous = interview.scheduledAt;
        await tx.interview.update({
            where: { id: interview.id },
            // Phase 3a — the calendar follows the new time; the reminder pause
            // a candidate's request set ends here.
            data: {
                scheduledAt: when,
                ...calendarSyncMark(nextCalendarAction({ calendarEventId: interview.calendarEventId })),
                remindersPausedAt: null,
            },
        });
        // Phase 3a — the old slot's reminders say nothing about the new one.
        await resetRemindersForReschedule(tx, { tenantId, interviewId: interview.id });
        await tx.interviewLifecycleEvent.create({
            data: scopedData(tenantId, {
                interviewId: interview.id,
                eventType: "RESCHEDULED",
                reasonCode: reason.code,
                notes: reason.notes,
                previousScheduledAt: previous,
                newScheduledAt: when,
                actorId: toInt(actorId),
            }),
        });
        // §5.3a — ONLY NOW does the panel learn. One event, on confirmation.
        await enqueueHrDomainEvent(
            tx,
            interviewRescheduledEvent(
                { ...interview, candidateId: interview.application?.candidateId ?? null, scheduledAt: when },
                { actorId: toInt(actorId) ?? null },
                { previousScheduledAt: previous ? previous.toISOString() : null, reasonCode: reason.code, interviewerIds },
            ),
        );
        await logAction({
            employeeId: toInt(actorId) ?? null,
            type: "UPDATE",
            module: AUDIT_MODULE,
            result: "SUCCESS",
            notes: `Interview "${interview.id}" rescheduled (${reason.code})`,
            tenantId: tenantId ?? null,
        });
        return { interviewId: interview.id, previousScheduledAt: previous, newScheduledAt: when };
    });
};

// ── Phase 3a — no-show ───────────────────────────────────────────────────────

const NO_SHOW_NOTES_MAX = 1000;

/**
 * Mark a candidate as not having attended. Only a SCHEDULED interview whose
 * start has passed qualifies (a future interview cannot have been missed; a
 * completed, cancelled or already no-show one is decided). The status write
 * is guarded on SCHEDULED, so two concurrent marks record one fact.
 *
 * @param {object} p
 * @param {object|null} [p.scope]  the caller's recruitment scope (interviewScopeWhere); null = unscoped
 */
export const markNoShow = async ({ interviewId, tenantId, actorId = null, notes = null, scope = null, now = new Date() }) => {
    const text = typeof notes === "string" ? notes.trim() : "";
    if (text.length > NO_SHOW_NOTES_MAX) {
        throw failCode(`notes must be at most ${NO_SHOW_NOTES_MAX} characters`, 400, "HR-RECRUITMENT-SCHEDULE-NOTES-TOO-LONG");
    }
    const at = new Date(now);
    const actor = toInt(actorId);

    return tenantTransaction(prisma, async (tx) => {
        const interview = await tx.interview.findFirst({
            where: scopedWhere(tenantId, { id: toInt(interviewId) ?? 0, ...(scope ? interviewScopeWhere(scope) : {}) }),
            select: {
                id: true, tenantId: true, applicationId: true, scheduledAt: true, status: true,
                interviewers: { select: { employeeId: true } },
                application: {
                    select: { candidateId: true, jobRequisitionId: true, jobRequisition: { select: { requestedById: true } } },
                },
            },
        });
        if (!interview) throw failCode("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND");
        if (interview.status !== "SCHEDULED") {
            throw failCode(`Only a scheduled interview can be marked no-show (this one is ${String(interview.status).toLowerCase()})`, 409, "HR-RECRUITMENT-SCHEDULE-NOT-SCHEDULED");
        }
        if (new Date(interview.scheduledAt).getTime() > at.getTime()) {
            throw failCode("The interview has not started yet", 409, "HR-RECRUITMENT-SCHEDULE-NOT-STARTED");
        }

        const claimed = await tx.interview.updateMany({
            where: scopedWhere(tenantId, { id: interview.id, status: "SCHEDULED" }),
            data: {
                status: "NO_SHOW",
                noShowAt: at,
                ...calendarSyncMark(CALENDAR_SYNC_ACTION.CANCEL, at),
            },
        });
        if (!claimed.count) {
            throw failCode("The interview is no longer scheduled", 409, "HR-RECRUITMENT-SCHEDULE-NOT-SCHEDULED");
        }

        await tx.interviewLifecycleEvent.create({
            data: scopedData(tenantId, {
                interviewId: interview.id,
                eventType: "NO_SHOW",
                reasonCode: NO_SHOW_REASON_CODE,
                notes: text || null,
                previousScheduledAt: interview.scheduledAt,
                actorId: actor,
            }),
        });
        const interviewerIds = interview.interviewers.map((i) => i.employeeId);
        await enqueueHrDomainEvent(
            tx,
            interviewNoShowEvent(
                {
                    ...interview,
                    candidateId: interview.application?.candidateId ?? null,
                    requisitionId: interview.application?.jobRequisitionId ?? null,
                },
                { actorId: actor },
                {
                    recruiterId: interview.application?.jobRequisition?.requestedById ?? null,
                    noShowAt: at,
                    interviewerIds,
                },
            ),
        );
        await logAction({
            employeeId: actor ?? null,
            type: "UPDATE",
            module: AUDIT_MODULE,
            result: "SUCCESS",
            notes: `Interview "${interview.id}" marked no-show`,
            tenantId: tenantId ?? null,
        });
        return { interviewId: interview.id, status: "NO_SHOW", noShowAt: at };
    }, { tenantId });
};

// ── Recruitment Phase 7 (B5) — panel roles ─────────────────────────────────

const PANEL_ROLE_MAX_ENTRIES = 20;

/** 503 while evaluation forms are off: panel roles only exist for forms. */
export function assertPanelRolesEnabled() {
    if (!isRecruitmentFlagEnabled("evaluationForms")) {
        throw failCode("Panel roles need evaluation forms, which are not enabled", 503, "HR-RECRUITMENT-EVALUATION-FORMS-DISABLED");
    }
}

/**
 * The panel roles a caller asked for, as Map<employeeId, role|null>. Accepts
 * a list [{ employeeId, panelRole }] (panelRole null or "" clears a role) or a
 * map { "<employeeId>": role }. Every employee must be on the panel
 * (panelIds) when one is given; every role must be one of PANEL_ROLES.
 * Empty input is an empty map (nothing to set).
 */
export function normalizePanelRoles(input, panelIds = null) {
    const entries = Array.isArray(input)
        ? input.map((e) => [e?.employeeId, e?.panelRole])
        : input && typeof input === "object"
            ? Object.entries(input)
            : [];
    if (entries.length > PANEL_ROLE_MAX_ENTRIES) {
        throw failCode(`At most ${PANEL_ROLE_MAX_ENTRIES} panel roles at a time`, 400, "HR-RECRUITMENT-PANEL-ROLE-INVALID");
    }
    const panel = panelIds ? new Set([...panelIds].map(Number)) : null;
    const roles = new Map();
    for (const [rawId, rawRole] of entries) {
        const employeeId = toInt(rawId);
        if (!employeeId) throw failCode("Each panel role needs the panelist's employee id", 400, "HR-RECRUITMENT-PANEL-ROLE-INVALID");
        if (panel && !panel.has(employeeId)) {
            throw failCode(`Employee ${employeeId} is not on this interview's panel`, 400, "HR-RECRUITMENT-PANEL-ROLE-NOT-PANELIST");
        }
        if (roles.has(employeeId)) {
            throw failCode(`Employee ${employeeId} is given two panel roles`, 400, "HR-RECRUITMENT-PANEL-ROLE-INVALID");
        }
        const text = rawRole == null ? "" : String(rawRole).trim().toUpperCase();
        if (text && !PANEL_ROLES.includes(text)) {
            throw failCode(`panelRole must be one of ${PANEL_ROLES.join(", ")}`, 400, "HR-RECRUITMENT-PANEL-ROLE-INVALID");
        }
        roles.set(employeeId, text || null);
    }
    return roles;
}

/** True when the caller sent any panel role input at all. */
export const hasPanelRoleInput = (input) =>
    Array.isArray(input) ? input.length > 0 : Boolean(input && typeof input === "object" && Object.keys(input).length);

// Recruiters change any panel; a hiring manager only the panels of their own
// requisitions (sitting on another manager's panel is not ownership).
function panelEditWhere(scope) {
    if (!scope || scope.unrestricted) return {};
    if (scope.level === RECRUITMENT_SCOPE.MANAGED && scope.employeeId) {
        return { application: { jobRequisition: { requestedById: scope.employeeId } } };
    }
    throw failCode("Only recruiters and the requisition's hiring manager can set panel roles", 403, "HR-RECRUITMENT-PANEL-ROLE-FORBIDDEN");
}

/**
 * Set (or clear) panelists' roles on an interview that has not started yet.
 * Only the listed panelists change; the rest keep theirs. A started,
 * completed, cancelled or no-show interview is refused: a panelist may be
 * mid-way through the form their role decides.
 *
 * @param {object} p
 * @param {Array<{employeeId:number, panelRole:string|null}>|object} p.roles
 * @param {object|null} [p.scope]  resolveRecruitmentScope(user); null = unscoped (internal callers)
 * @returns {Promise<{ interviewId: number, panel: Array<{employeeId:number, employeeName:string|null, panelRole:string|null}>, changed: number }>}
 */
export const setInterviewPanelRoles = async ({ interviewId, roles, tenantId, actorId = null, scope = null, now = new Date() }) => {
    assertPanelRolesEnabled();
    if (!hasPanelRoleInput(roles)) throw failCode("roles must list at least one panelist", 400, "HR-RECRUITMENT-PANEL-ROLE-INVALID");
    const scopeWhere = panelEditWhere(scope);
    const actor = toInt(actorId);

    return tenantTransaction(prisma, async (tx) => {
        const interview = await tx.interview.findFirst({
            where: scopedWhere(tenantId, { id: toInt(interviewId) ?? 0, ...scopeWhere }),
            select: {
                id: true, tenantId: true, applicationId: true, scheduledAt: true, status: true, decision: true,
                interviewers: { select: { employeeId: true, panelRole: true } },
                application: { select: { candidateId: true } },
            },
        });
        if (!interview) throw failCode("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND");
        if (interview.status !== "SCHEDULED" || new Date(interview.scheduledAt).getTime() <= new Date(now).getTime()) {
            throw failCode("Panel roles can only change before the interview starts", 409, "HR-RECRUITMENT-PANEL-ROLE-LOCKED");
        }

        const panelIds = interview.interviewers.map((i) => i.employeeId);
        const wanted = normalizePanelRoles(roles, panelIds);
        const current = new Map(interview.interviewers.map((i) => [i.employeeId, i.panelRole ?? null]));
        let changed = 0;
        for (const [employeeId, panelRole] of wanted) {
            if (current.get(employeeId) === panelRole) continue;
            await tx.interviewInterviewer.updateMany({
                where: scopedWhere(tenantId, { interviewId: interview.id, employeeId }),
                data: { panelRole },
            });
            current.set(employeeId, panelRole);
            changed += 1;
        }

        if (changed) {
            await enqueueHrDomainEvent(
                tx,
                interviewUpdatedEvent(
                    { ...interview, candidateId: interview.application?.candidateId ?? null },
                    { actorId: actor },
                    { changedFields: ["panelRoles"], interviewerIds: panelIds },
                ),
            );
            await logAction({
                employeeId: actor ?? null,
                type: "UPDATE",
                module: AUDIT_MODULE,
                result: "SUCCESS",
                notes: `Panel roles changed on interview "${interview.id}" (${changed} panelist(s))`,
                tenantId: tenantId ?? null,
            });
        }

        const names = await employeeNamesById(tx, tenantId, panelIds);
        return {
            interviewId: interview.id,
            changed,
            panel: panelIds.map((employeeId) => ({
                employeeId,
                employeeName: nameOf(names, employeeId),
                panelRole: current.get(employeeId) ?? null,
            })),
        };
    }, { tenantId });
};

// ── §5.1a/5.1b — the calendar linkage ────────────────────────────────────────

/**
 * Record/refresh the external calendar linkage for an interview (§5.1a). The
 * Communication calendar-sync boundary calls this AFTER it writes the provider
 * event — HR stores the linkage, never the event content.
 */
export const markCalendarSync = async ({ interviewId, provider, calendarEventId, status, tenantId }) => {
    const prov = String(provider ?? "").trim();
    const eventId = String(calendarEventId ?? "").trim();
    const st = String(status ?? "").trim().toUpperCase();
    if (!prov || !eventId) throw fail("provider and calendarEventId are required", 400, { code: "HR-RECRUITMENT-SCHEDULE-CALENDAR-ARGS" });
    if (!["PENDING", "SYNCED", "FAILED"].includes(st)) {
        throw fail("status must be PENDING, SYNCED or FAILED", 400, { code: "HR-RECRUITMENT-SCHEDULE-CALENDAR-ARGS" });
    }
    const id = toInt(interviewId);
    const where = scopedWhere(tenantId, { id: id ?? 0 });
    const before = await prisma.interview.findFirst({ where, select: { id: true } });
    if (!before) throw fail("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND");

    const row = await prisma.interview.update({
        where: { id: before.id },
        data: {
            calendarProvider: prov,
            calendarEventId: eventId,
            calendarSyncStatus: st,
            ...(st === "SYNCED" ? { calendarSyncedAt: new Date() } : {}),
        },
    });
    return {
        interviewId: row.id,
        calendarProvider: row.calendarProvider,
        calendarEventId: row.calendarEventId,
        calendarSyncStatus: row.calendarSyncStatus,
        calendarSyncedAt: row.calendarSyncedAt,
    };
};

/** The lifecycle history of one interview, oldest first (the order it happened). */
export const listLifecycleEvents = async ({ interviewId, tenantId }) => {
    const interview = await requireInterview(interviewId, tenantId);
    return prisma.interviewLifecycleEvent.findMany({
        where: scopedWhere(tenantId, { interviewId: interview.id }),
        orderBy: { id: "asc" },
    });
};

// Re-export so the schedule path in interview.service.js can share the
// availability check without importing the lib twice.
export { checkInterviewerAvailability as availabilityForSlot };

// src/services/interviewSchedule.service.js
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

import prisma from "../config/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import { logAction } from "../utils/logs.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import {
    interviewCancelledEvent,
    interviewRescheduledEvent,
    interviewRescheduleRequestedEvent,
    interviewScheduledEvent,
} from "./hrEvents.js";
import {
    blockedInterviewers,
    validateConflictOverride,
    validateLifecycleReason,
} from "../lib/interviewScheduling.js";

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
export const cancelInterview = async ({ interviewId, reasonCode, notes, tenantId, actorId }) => {
    const reason = validateLifecycleReason({ reasonCode, notes });
    if (!reason.ok) throw fail(reason.error, 400, { code: "HR-RECRUITMENT-SCHEDULE-REASON-INVALID" });

    return tenantTransaction(prisma, async (tx) => {
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

/**
 * Which of these interviewers are on APPROVED leave overlapping the slot, and
 * whose effective schedule marks the date non-working? §5.2 says check HR
 * attendance/leave/work schedule; §5.2a fixes the tiers.
 *
 * @returns {{ blocked: number[], nonWorkingDay: number[] }}
 */
export const checkInterviewerAvailability = async ({ scheduledAt, durationMinutes = 60, interviewerIds, tenantId }) => {
    const start = toDate(scheduledAt);
    if (!start) throw fail("scheduledAt must be a valid ISO 8601 datetime", 400);
    const end = new Date(start.getTime() + Number(durationMinutes || 60) * 60000);
    const ids = (interviewerIds ?? []).map(toInt).filter(Boolean);
    if (!ids.length) return { blocked: [], nonWorkingDay: [] };

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

    // §5.2 — the work schedule: one effective schedule per interviewer for the
    // slot's date. schedule_pattern follows the weekly map the attendance and
    // overtime services already read (monday..sunday, ""/absent = off).
    const dayKey = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][start.getDay()];
    const schedules = await prisma.workSchedule.findMany({
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
    const nonWorkingDay = ids.filter((id) => {
        const pattern = patternByEmployee.get(id);
        // No schedule at all → cannot claim a conflict; fail open for the
        // WARNING tier (a hard block needs evidence).
        if (!pattern || typeof pattern !== "object") return false;
        const timing = pattern[dayKey];
        return !(typeof timing === "string" && timing.trim() !== "");
    });

    return { blocked, nonWorkingDay };
};

// ── §5.3/5.3a — reschedule request → recruiter confirms ─────────────────────

/**
 * A candidate requests a reschedule (§5.3). Recorded as RESCHEDULE_REQUESTED
 * with the coded reason (the §5.4 vocabulary applies — CANDIDATE_REQUEST is
 * the expected code); NO panel event fires here (§5.3a). The requested time is
 * stored on the event row for the recruiter to confirm against.
 */
export const requestReschedule = async ({ interviewId, reasonCode, notes, requestedFor, tenantId, actorId }) => {
    const reason = validateLifecycleReason({ reasonCode, notes });
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
    const reason = validateLifecycleReason({ reasonCode, notes });
    if (!reason.ok) throw fail(reason.error, 400, { code: "HR-RECRUITMENT-SCHEDULE-REASON-INVALID" });
    const when = toDate(scheduledAt);
    if (!when) throw fail("scheduledAt must be a valid ISO 8601 datetime", 400);

    return tenantTransaction(prisma, async (tx) => {
        const id = toInt(interviewId);
        const interview = await tx.interview.findFirst({
            where: scopedWhere(tenantId, { id: id ?? 0 }),
            select: {
                id: true, tenantId: true, applicationId: true, scheduledAt: true, status: true, durationMinutes: true,
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

        const dayKey = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][when.getDay()];
        const schedules = interviewerIds.length
            ? await tx.workSchedule.findMany({
                where: scopedWhere(tenantId, {
                    employeeId: { in: interviewerIds },
                    effective_start_date: { lte: when },
                    OR: [{ effective_end_date: null }, { effective_end_date: { gte: when } }],
                }),
                orderBy: { effective_start_date: "desc" },
                select: { employeeId: true, schedule_pattern: true },
            })
            : [];
        const patternByEmployee = new Map();
        for (const s of schedules) {
            if (!patternByEmployee.has(s.employeeId)) patternByEmployee.set(s.employeeId, s.schedule_pattern);
        }
        const nonWorkingDay = interviewerIds.filter((eid) => {
            const pattern = patternByEmployee.get(eid);
            if (!pattern || typeof pattern !== "object") return false;
            const timing = pattern[dayKey];
            return !(typeof timing === "string" && timing.trim() !== "");
        });

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
            data: { scheduledAt: when, calendarSyncStatus: "PENDING" },
        });
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

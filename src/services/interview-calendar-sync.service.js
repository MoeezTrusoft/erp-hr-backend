// src/services/interview-calendar-sync.service.js
//
// Recruitment Phase 3a — writes interview changes to the panel's and the
// candidate's calendars through the Communication module, and retries what
// fails.
//
// The schedule paths (interview.service.js, interview-schedule.service.js)
// MARK an interview in the same transaction as the change: status PENDING,
// calendarSyncAction CREATE / UPDATE / CANCEL, attempts 0, due now. This file
// is the worker side:
//
//   1. a SYSTEM scan finds due rows across tenants (ids and tenants only):
//      PENDING or FAILED with a next attempt due, no live claim;
//   2. per row, under ITS tenant, a conditional updateMany claims it (lease 5
//      minutes): count 1 wins, 0 means another worker has it, so two
//      overlapping ticks never write the same event twice;
//   3. builds the event from a fixed list of fields (interview type,
//      requisition title, time, location or meeting link, panel names) and
//      the attendees: the panel's work email addresses, plus the candidate's
//      own address only when contact is allowed (an active do-not-contact
//      entry or withdrawn consent drops the candidate invite, never the
//      panel's event);
//   4. calls the client. Success records provider, event id, SYNCED and
//      announces hr.recruitment.interview_calendar_synced.v1 in the same
//      write. A retryable failure counts the attempt and backs off (1m, 5m,
//      30m, 2h, 6h); the 6th failure, or any non-retryable one, is FAILED
//      with the error CODE only (never a provider message) and announces
//      hr.recruitment.interview_calendar_sync_failed.v1.
//
// A CANCEL for an interview whose event was never written has nothing to
// cancel: it is settled SYNCED without a call.
//
// If the interview changes while a call is in flight, the mark moves
// calendarNextAttemptAt (the revision the worker read). The worker's settle
// then matches nothing; it keeps the event reference (so the next pass
// updates rather than creates a second event), releases its claim and leaves
// the newer mark PENDING. The idempotency key covers the other half: a create
// retried after a timeout, or after a lease ran out mid-call, replays on the
// Communication side instead of creating a duplicate.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitment-flags.util.js";
import { RECRUITMENT_SCOPE, requisitionScopeWhere } from "../lib/recruitment-access.util.js";
import { generateWorkerId, sanitiseWorkerId } from "../jobs/outbox.dispatcher.js";
import { assertCommunicationsAllowed } from "./candidate-privacy.service.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import {
    CalendarClientError,
    calendarIdempotencyKey,
    cancelEvent,
    createEvent,
    eventFingerprint,
    updateEvent,
} from "./communication-calendar.client.js";
import {
    CALENDAR_SYNC_ACTION,
    CALENDAR_SYNC_STATUS,
    calendarSyncMark,
    nextCalendarAction,
} from "./interview-schedule.service.js";

const log = logger.child({ component: "interview-calendar-sync" });

export const MAX_CALENDAR_SYNC_ATTEMPTS = 6;
export const CALENDAR_SYNC_BACKOFF_MS = Object.freeze([60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]);
export const CALENDAR_SYNC_LEASE_MS = 5 * 60_000;
export const DEFAULT_CALENDAR_SYNC_LIMIT = 25;
const MAX_CALENDAR_SYNC_LIMIT = 200;
const LAST_ERROR_MAX = 100;
const INTERNAL_ERROR_CODE = "HR-RECRUITMENT-CALENDAR-INTERNAL";

export const CALENDAR_SYNCED_EVENT = "hr.recruitment.interview_calendar_synced.v1";
export const CALENDAR_SYNC_FAILED_EVENT = "hr.recruitment.interview_calendar_sync_failed.v1";

const ENDED_STATUSES = Object.freeze(["CANCELLED", "NO_SHOW"]);

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

/** Delay before the next try after failed attempt n (1-based). */
export function calendarSyncBackoffMs(attempt) {
    const n = Math.max(1, Math.floor(Number(attempt) || 1));
    return CALENDAR_SYNC_BACKOFF_MS[Math.min(n, CALENDAR_SYNC_BACKOFF_MS.length) - 1];
}

const clampLimit = (limit) => {
    const n = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_CALENDAR_SYNC_LIMIT;
    return n <= 0 ? DEFAULT_CALENDAR_SYNC_LIMIT : Math.min(n, MAX_CALENDAR_SYNC_LIMIT);
};

// ── Events ───────────────────────────────────────────────────────────────────

function syncEvent(eventName, row, payload) {
    if (!row?.tenantId) return null;
    return {
        eventName,
        tenantId: row.tenantId,
        aggregateType: "Interview",
        aggregateId: row.id,
        actorId: null,
        payload: {
            interviewId: String(row.id),
            applicationId: row.applicationId != null ? String(row.applicationId) : null,
            ...payload,
        },
    };
}

/** hr.recruitment.interview_calendar_synced.v1 — ids, the action, the provider name. */
export const interviewCalendarSyncedEvent = (row, { action, provider = null, candidateInvited = false } = {}) =>
    syncEvent(CALENDAR_SYNCED_EVENT, row, { action, calendarProvider: provider, candidateInvited: Boolean(candidateInvited) });

/** hr.recruitment.interview_calendar_sync_failed.v1 — ids, the action, the error code. */
export const interviewCalendarSyncFailedEvent = (row, { action, errorCode, attempts } = {}) =>
    syncEvent(CALENDAR_SYNC_FAILED_EVENT, row, { action, errorCode: errorCode ?? null, attempts: Number(attempts) || 0 });

// ── Event content (pure) ─────────────────────────────────────────────────────

const TYPE_LABELS = Object.freeze({
    PHONE_SCREEN: "Phone screen",
    TECHNICAL: "Technical",
    BEHAVIORAL: "Behavioral",
    PANEL: "Panel",
    FINAL: "Final",
    ONSITE: "On-site",
    VIDEO: "Video",
});

export const interviewTypeLabel = (type) => TYPE_LABELS[String(type ?? "").toUpperCase()] ?? "Interview";

const employeeName = (e) => {
    const first = String(e?.first_name ?? "").trim();
    const last = String(e?.last_name ?? "").trim();
    if (first && last) return `${first} ${last}`;
    return String(e?.employee_name ?? "").trim() || first || last || null;
};

const employeeEmail = (e) => String(e?.work_email ?? "").trim() || String(e?.email ?? "").trim() || null;

/**
 * The calendar event for an interview, from the allowed fields ONLY: type,
 * requisition title, time, location or meeting link, panel names. Notes,
 * scores, decisions, salary and the candidate's details never enter it.
 */
export function buildCalendarEventContent(interview) {
    const start = new Date(interview.scheduledAt);
    const end = new Date(start.getTime() + Number(interview.durationMinutes || 60) * 60_000);
    const typeLabel = interviewTypeLabel(interview.interviewType);
    const jobTitle = String(interview.application?.jobRequisition?.title ?? "").trim() || null;
    const panelNames = (interview.interviewers ?? []).map((i) => employeeName(i.employee)).filter(Boolean);
    const location = String(interview.location ?? "").trim() || null;
    const lines = [
        `Interview type: ${typeLabel}`,
        ...(jobTitle ? [`Position: ${jobTitle}`] : []),
        `Time: ${start.toISOString()} to ${end.toISOString()}`,
        ...(location ? [`Location: ${location}`] : []),
        ...(panelNames.length ? [`Panel: ${panelNames.join(", ")}`] : []),
    ];
    return {
        title: jobTitle ? `${typeLabel} interview: ${jobTitle}` : `${typeLabel} interview`,
        description: lines.join("\n"),
        start,
        end,
        location,
        panelNames,
    };
}

/** The panel's attendee entries (employees without an address are left out). */
export function panelAttendees(interview) {
    return (interview.interviewers ?? [])
        .map((i) => ({ email: employeeEmail(i.employee), name: employeeName(i.employee), role: "required" }))
        .filter((a) => a.email);
}

/**
 * The candidate's own invite, or null when the candidate must not be
 * contacted (do-not-contact, withdrawn consent, anonymized, no address).
 * Read-only: the privacy service decides, nothing is recorded here.
 */
export async function candidateAttendee(tenantId, interview, now) {
    const candidate = interview.application?.candidate;
    if (!candidate || candidate.anonymizedAt) return null;
    try {
        const verdict = await assertCommunicationsAllowed({ tenantId, candidateId: candidate.id, purpose: "PROCESSING", at: now });
        const email = String(verdict?.email ?? candidate.email ?? "").trim();
        if (!email) return null;
        const name = [candidate.firstName, candidate.lastName].map((p) => String(p ?? "").trim()).filter(Boolean).join(" ") || null;
        return { email, name, role: "required" };
    } catch {
        // Blocked (or unreadable): the panel's event still goes ahead.
        return null;
    }
}

// The revision a write belongs to. A create and a cancel happen once per
// interview, so the row's creation instant names them; an update is named by
// the content it writes, so a retry of the same update replays and a newer
// update is a new write.
function writeVersion(action, interview, content, attendees) {
    if (action !== CALENDAR_SYNC_ACTION.UPDATE) return new Date(interview.created_at ?? 0).getTime();
    return eventFingerprint({
        start: content.start.toISOString(),
        end: content.end.toISOString(),
        location: content.location,
        title: content.title,
        attendees: attendees.map((a) => a.email).sort(),
    });
}

// ── The worker ───────────────────────────────────────────────────────────────

const dueWhere = (now) => ({
    calendarSyncStatus: { in: [CALENDAR_SYNC_STATUS.PENDING, CALENDAR_SYNC_STATUS.FAILED] },
    calendarNextAttemptAt: { lte: now },
    OR: [{ calendarClaimExpiresAt: null }, { calendarClaimExpiresAt: { lt: now } }],
});

const heldWhere = (tenantId, id, workerId) => withTenant(tenantId, { id, calendarClaimedBy: workerId });

// Held by this worker AND still the revision it read: a re-mark moves
// calendarNextAttemptAt, so a settle for an older revision matches nothing.
const currentWhere = (tenantId, interview, workerId) => ({
    ...heldWhere(tenantId, interview.id, workerId),
    calendarNextAttemptAt: interview.calendarNextAttemptAt,
});

const RELEASED = Object.freeze({ calendarClaimedBy: null, calendarClaimExpiresAt: null });

const SYNC_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    applicationId: true,
    interviewType: true,
    scheduledAt: true,
    durationMinutes: true,
    location: true,
    status: true,
    created_at: true,
    calendarProvider: true,
    calendarEventId: true,
    calendarSyncAction: true,
    calendarSyncAttempts: true,
    calendarNextAttemptAt: true,
    interviewers: {
        select: {
            employeeId: true,
            employee: { select: { id: true, first_name: true, last_name: true, employee_name: true, work_email: true, email: true } },
        },
    },
    application: {
        select: {
            candidateId: true,
            jobRequisition: { select: { title: true } },
            candidate: { select: { id: true, firstName: true, lastName: true, email: true, anonymizedAt: true } },
        },
    },
});

async function claimRow(tenantId, id, workerId, now) {
    const result = await prisma.interview.updateMany({
        where: withTenant(tenantId, { id, ...dueWhere(now) }),
        data: { calendarClaimedBy: workerId, calendarClaimExpiresAt: new Date(now.getTime() + CALENDAR_SYNC_LEASE_MS) },
    });
    return Number(result?.count ?? 0) === 1;
}

/**
 * The action the row needs NOW, reconciled with its state: an interview that
 * ended always cancels; a create for an event that already exists updates it;
 * an update with no event to update creates one.
 */
export function resolveAction(interview) {
    const ended = ENDED_STATUSES.includes(interview.status);
    const action = ended ? CALENDAR_SYNC_ACTION.CANCEL : (interview.calendarSyncAction ?? nextCalendarAction(interview));
    if (action === CALENDAR_SYNC_ACTION.CANCEL) return action;
    return interview.calendarEventId ? CALENDAR_SYNC_ACTION.UPDATE : CALENDAR_SYNC_ACTION.CREATE;
}

/** Record the outcome while the claim holds; keep a new event's id if it does not. */
async function settleSynced(tenantId, interview, workerId, now, { action, ref, candidateInvited }) {
    return tenantTransaction(
        prisma,
        async (tx) => {
            const linkage = ref ? { calendarProvider: ref.provider, calendarEventId: ref.eventId } : {};
            const result = await tx.interview.updateMany({
                where: currentWhere(tenantId, interview, workerId),
                data: {
                    ...linkage,
                    calendarSyncStatus: CALENDAR_SYNC_STATUS.SYNCED,
                    calendarSyncedAt: now,
                    calendarSyncAttempts: 0,
                    calendarNextAttemptAt: null,
                    calendarLastError: null,
                    ...RELEASED,
                },
            });
            if (Number(result?.count ?? 0) === 1) {
                if (ref || action !== CALENDAR_SYNC_ACTION.CANCEL) {
                    await enqueueHrDomainEvent(tx, interviewCalendarSyncedEvent(interview, { action, provider: ref?.provider, candidateInvited }));
                }
                return ref || action !== CALENDAR_SYNC_ACTION.CANCEL ? "synced" : "noop";
            }
            // The interview changed while the call was in flight. A new event
            // must not be forgotten, or the next pass would create a second.
            if (ref && action === CALENDAR_SYNC_ACTION.CREATE) {
                await tx.interview.updateMany({
                    where: withTenant(tenantId, { id: interview.id, calendarEventId: null, calendarSyncAction: CALENDAR_SYNC_ACTION.CREATE }),
                    data: { ...linkage, calendarSyncAction: CALENDAR_SYNC_ACTION.UPDATE },
                });
                await tx.interview.updateMany({
                    where: withTenant(tenantId, { id: interview.id, calendarEventId: null }),
                    data: linkage,
                });
            }
            await releaseClaim(tx, tenantId, interview.id, workerId);
            return "superseded";
        },
        { tenantId },
    );
}

// Let the newer mark run on the next pass instead of waiting out the lease.
const releaseClaim = (tx, tenantId, id, workerId) =>
    tx.interview.updateMany({ where: heldWhere(tenantId, id, workerId), data: { ...RELEASED } });

async function recordFailure(tenantId, interview, workerId, now, { action, err }) {
    const attempts = (interview.calendarSyncAttempts ?? 0) + 1;
    const retryable = err instanceof CalendarClientError ? err.retryable : true;
    const terminal = !retryable || attempts >= MAX_CALENDAR_SYNC_ATTEMPTS;
    const errorCode = String(err?.code || INTERNAL_ERROR_CODE).slice(0, LAST_ERROR_MAX);
    return tenantTransaction(
        prisma,
        async (tx) => {
            const result = await tx.interview.updateMany({
                where: currentWhere(tenantId, interview, workerId),
                data: {
                    calendarSyncStatus: CALENDAR_SYNC_STATUS.FAILED,
                    calendarSyncAttempts: attempts,
                    calendarLastError: errorCode,
                    calendarNextAttemptAt: terminal ? null : new Date(now.getTime() + calendarSyncBackoffMs(attempts)),
                    ...RELEASED,
                },
            });
            if (Number(result?.count ?? 0) !== 1) {
                await releaseClaim(tx, tenantId, interview.id, workerId);
                return "superseded";
            }
            if (terminal) await enqueueHrDomainEvent(tx, interviewCalendarSyncFailedEvent(interview, { action, errorCode, attempts }));
            return terminal ? "failed" : "retry";
        },
        { tenantId },
    );
}

async function callProvider(tenantId, interview, action, now) {
    const idOnly = { id: interview.id };
    if (action === CALENDAR_SYNC_ACTION.CANCEL) {
        const idempotencyKey = calendarIdempotencyKey({ interviewId: interview.id, action, version: writeVersion(action, interview) });
        await cancelEvent({ provider: interview.calendarProvider, eventId: interview.calendarEventId, tenantId, interview: idOnly, idempotencyKey });
        return { ref: { provider: interview.calendarProvider, eventId: interview.calendarEventId }, candidateInvited: false };
    }
    const content = buildCalendarEventContent(interview);
    const candidate = await candidateAttendee(tenantId, interview, now);
    const attendees = [...panelAttendees(interview), ...(candidate ? [candidate] : [])];
    const idempotencyKey = calendarIdempotencyKey({ interviewId: interview.id, action, version: writeVersion(action, interview, content, attendees) });
    const body = {
        tenantId,
        interview: idOnly,
        attendees,
        title: content.title,
        description: content.description,
        start: content.start,
        end: content.end,
        location: content.location,
        idempotencyKey,
    };
    const ref = action === CALENDAR_SYNC_ACTION.CREATE
        ? await createEvent(body)
        : await updateEvent({ ...body, provider: interview.calendarProvider, eventId: interview.calendarEventId });
    return { ref, candidateInvited: Boolean(candidate) };
}

/** One claimed row, start to finish. Returns the outcome label. */
async function processRow(tenantId, id, workerId, now) {
    if (!(await claimRow(tenantId, id, workerId, now))) return "raceLost";
    const interview = await prisma.interview.findFirst({ where: heldWhere(tenantId, id, workerId), select: SYNC_SELECT });
    if (!interview) return "raceLost";
    const action = resolveAction(interview);
    if (action === CALENDAR_SYNC_ACTION.CANCEL && !interview.calendarEventId) {
        return settleSynced(tenantId, interview, workerId, now, { action, ref: null, candidateInvited: false });
    }
    try {
        const { ref, candidateInvited } = await callProvider(tenantId, interview, action, now);
        return await settleSynced(tenantId, interview, workerId, now, { action, ref, candidateInvited });
    } catch (err) {
        log.warn({ interviewId: id, action, code: err?.code ?? null, retryable: err?.retryable ?? null }, "interview calendar sync: call failed");
        return recordFailure(tenantId, interview, workerId, now, { action, err });
    }
}

/**
 * One sync pass. Safe to run concurrently (claims), idempotent, and one bad
 * row never stops the run.
 *
 * @param {{ now?: Date, limit?: number, workerId?: string }} [args]
 * @returns {Promise<object>} counts per outcome, or { skipped: "FLAG_OFF" }
 */
export async function runInterviewCalendarSyncTick({ now = new Date(), limit, workerId } = {}) {
    if (!isRecruitmentFlagEnabled("calendarSync")) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const worker = sanitiseWorkerId(workerId) || generateWorkerId();
    const summary = { scanned: 0, synced: 0, noop: 0, retry: 0, failed: 0, superseded: 0, raceLost: 0, errors: 0 };

    const due = await mcpCtx.run({ system: true }, async () =>
        await prisma.interview.findMany({
            where: { ...dueWhere(at), tenantId: { not: null } },
            select: { id: true, tenantId: true },
            orderBy: [{ calendarNextAttemptAt: "asc" }, { id: "asc" }],
            take: clampLimit(limit),
        }),
    );
    summary.scanned = due.length;

    for (const row of due) {
        if (!row.tenantId) continue;
        try {
            const outcome = await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () => await processRow(row.tenantId, row.id, worker, at));
            summary[outcome] = (summary[outcome] ?? 0) + 1;
        } catch (err) {
            // The claim lapses on its own, so the row is retried after the lease.
            summary.errors += 1;
            log.error({ interviewId: row.id, errMessage: err?.message }, "interview calendar sync: row failed");
        }
    }
    if (summary.scanned) log.info({ ...summary, workerId: worker }, "interview calendar sync: tick done");
    return summary;
}

// ── Re-queue one interview (the hr_interview_calendar_resync tool) ──────────

/**
 * Queue one interview for a fresh calendar write: CANCEL when it has ended,
 * UPDATE when an event exists, else CREATE. ORG callers, or a hiring manager
 * on their own requisition. Also the way to sync an interview marked PENDING
 * before Phase 3a (no next-attempt time, so the worker never picks it up).
 */
export async function requeueInterviewCalendarSync({ interviewId, tenantId, scope = null, now = new Date() } = {}) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    const level = scope?.level ?? RECRUITMENT_SCOPE.ORG;
    if (scope && !scope.unrestricted && level !== RECRUITMENT_SCOPE.MANAGED) {
        throw fail("Only recruiters and the requisition's hiring manager can re-sync a calendar", 403, "HR-RECRUITMENT-CALENDAR-FORBIDDEN");
    }
    const id = Number(interviewId);
    if (!Number.isInteger(id) || id <= 0) throw fail("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND");
    const managed = scope && !scope.unrestricted ? { application: { jobRequisition: requisitionScopeWhere(scope) } } : {};

    return tenantTransaction(
        prisma,
        async (tx) => {
            const interview = await tx.interview.findFirst({
                where: withTenant(tenantId, { id, ...managed }),
                select: { id: true, status: true, calendarEventId: true },
            });
            if (!interview) throw fail("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND");
            const action = nextCalendarAction({
                calendarEventId: interview.calendarEventId,
                cancel: ENDED_STATUSES.includes(interview.status),
            });
            await tx.interview.update({ where: { id: interview.id }, data: calendarSyncMark(action, now) });
            return {
                interviewId: interview.id,
                calendarSyncStatus: CALENDAR_SYNC_STATUS.PENDING,
                calendarSyncAction: action,
                calendarSyncEnabled: isRecruitmentFlagEnabled("calendarSync"),
            };
        },
        { tenantId },
    );
}

export default { runInterviewCalendarSyncTick, requeueInterviewCalendarSync };

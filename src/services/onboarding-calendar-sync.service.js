// src/services/onboarding-calendar-sync.service.js
//
// Recruitment Phase 4 (plan 6.7 "Orientation scheduling") — writes onboarding
// sessions to the new hire's and the host's calendars through the
// Communication module, and retries what fails. It mirrors the interview
// calendar worker (interview-calendar-sync.service.js) and reuses its
// constants (lease, backoff, attempt ceiling, batch size):
//
//   1. a SYSTEM scan finds due sessions across tenants (ids and tenants
//      only): PENDING, or FAILED with a next attempt due, no live claim;
//   2. per row, under ITS tenant, a conditional updateMany claims it; count 1
//      wins, so two overlapping ticks never write the same event twice;
//   3. builds the event from a fixed list of fields (session title and type,
//      time, place, whether attendance is required, the host's name) and the
//      attendees: the new hire's work email (else personal email) and the
//      host's. Checklist notes, documents and survey answers never enter it;
//   4. calls the client. Success records provider, event id, SYNCED and
//      announces hr.onboarding.session_calendar_synced.v1 in the same write.
//      A retryable failure backs off; the last attempt, or a non-retryable
//      failure, is FAILED with the error CODE only and announces
//      hr.onboarding.session_calendar_sync_failed.v1.
//
// What the row needs is reconciled at claim time:
//   * a TOMBSTONE (calendarSyncAction CANCEL: HR deleted the session) cancels
//     the event and then deletes the row; without an event it is deleted;
//   * a session with no date (HR cleared it) cancels its event and forgets
//     it, so a later date creates a fresh one; with no event it is a no-op;
//   * otherwise UPDATE when an event exists, else CREATE.
//
// The calls go through callCalendarTool directly, not createEvent, so the
// event's source and sourceRef name the onboarding session rather than an
// interview with the same id.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { mcpCtx } from "../mcp/context.js";
import { withTenant } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import {
    SESSION_CALENDAR_ACTION,
    SESSION_CALENDAR_STATUS,
    isOnboardingCalendarEnabled,
    isSessionTombstone,
    nextSessionCalendarAction,
    sessionCalendarMark,
    sessionTimeRange,
    sessionTypeLabel,
} from "../lib/onboarding-sessions.util.js";
import { generateWorkerId, sanitiseWorkerId } from "../jobs/outbox.dispatcher.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { getRecruitmentSettings } from "./recruitment-settings.service.js";
import { CALENDAR_ERROR, CalendarClientError, callCalendarTool, eventFingerprint } from "./communication-calendar.client.js";
import {
    CALENDAR_SYNC_LEASE_MS,
    DEFAULT_CALENDAR_SYNC_LIMIT,
    MAX_CALENDAR_SYNC_ATTEMPTS,
    calendarSyncBackoffMs,
} from "./interview-calendar-sync.service.js";

const log = logger.child({ component: "onboarding-calendar-sync" });

const MAX_LIMIT = 200;
const LAST_ERROR_MAX = 100;
const INTERNAL_ERROR_CODE = "HR-ONBOARDING-CALENDAR-INTERNAL";
export const NO_ATTENDEES_CODE = "HR-ONBOARDING-CALENDAR-NO-ATTENDEES";
const EVENT_SOURCE = "hr.onboarding.session";

export const SESSION_CALENDAR_SYNCED_EVENT = "hr.onboarding.session_calendar_synced.v1";
export const SESSION_CALENDAR_SYNC_FAILED_EVENT = "hr.onboarding.session_calendar_sync_failed.v1";

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const clampLimit = (limit) => {
    const n = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_CALENDAR_SYNC_LIMIT;
    return n <= 0 ? DEFAULT_CALENDAR_SYNC_LIMIT : Math.min(n, MAX_LIMIT);
};

const sourceRef = (sessionId) => `hr-onboarding-session-${sessionId}`;

/** `hr-onboarding-session-${id}-${action}-${version}`: a retried write replays. */
export function sessionIdempotencyKey({ sessionId, action, version }) {
    return `${sourceRef(sessionId)}-${String(action).toUpperCase()}-${version ?? "0"}`;
}

// ── Events ───────────────────────────────────────────────────────────────────

function syncEvent(eventName, row, payload) {
    if (!row?.tenantId) return null;
    return {
        eventName,
        tenantId: row.tenantId,
        aggregateType: "OnboardingSession",
        aggregateId: row.id,
        actorId: null,
        payload: {
            sessionId: String(row.id),
            checklistId: row.checklistId != null ? String(row.checklistId) : null,
            employeeId: row.checklist?.employeeId != null ? String(row.checklist.employeeId) : null,
            assigneeId: row.assigneeId != null ? String(row.assigneeId) : null,
            ...payload,
        },
    };
}

/** hr.onboarding.session_calendar_synced.v1 — ids, the action, the provider name. */
export const sessionCalendarSyncedEvent = (row, { action, provider = null, newHireInvited = false } = {}) =>
    syncEvent(SESSION_CALENDAR_SYNCED_EVENT, row, { action, calendarProvider: provider, newHireInvited: Boolean(newHireInvited) });

/** hr.onboarding.session_calendar_sync_failed.v1 — ids, the action, the error code. */
export const sessionCalendarSyncFailedEvent = (row, { action, errorCode, attempts } = {}) =>
    syncEvent(SESSION_CALENDAR_SYNC_FAILED_EVENT, row, { action, errorCode: errorCode ?? null, attempts: Number(attempts) || 0 });

// ── Event content (pure) ─────────────────────────────────────────────────────

const employeeName = (e) => {
    const first = String(e?.first_name ?? "").trim();
    const last = String(e?.last_name ?? "").trim();
    if (first && last) return `${first} ${last}`;
    return String(e?.employee_name ?? "").trim() || first || last || null;
};

const employeeEmail = (e) => String(e?.work_email ?? "").trim() || String(e?.email ?? "").trim() || null;

/**
 * The calendar event for a session, from the allowed fields ONLY: title,
 * type, time, place, required, the host's name.
 */
export function buildSessionEventContent(session, host, settings) {
    const range = sessionTimeRange(session, settings);
    const typeLabel = sessionTypeLabel(session.sessionType);
    const location = String(session.location ?? "").trim() || null;
    const hostName = host ? employeeName(host) : null;
    const title = String(session.title ?? "").trim() || `${typeLabel} session`;
    const lines = [
        `Onboarding session: ${typeLabel}`,
        `Time: ${range.start.toISOString()} to ${range.end.toISOString()}`,
        ...(location ? [`Location: ${location}`] : []),
        ...(hostName ? [`Host: ${hostName}`] : []),
        `Attendance: ${session.required ? "required" : "optional"}`,
    ];
    return { title, description: lines.join("\n"), start: range.start, end: range.end, location };
}

/** The new hire and the host, each once, without an address left out. */
export function sessionAttendees(newHire, host) {
    const out = [];
    for (const person of [newHire, host]) {
        const email = employeeEmail(person);
        if (!email || out.some((a) => a.email.toLowerCase() === email.toLowerCase())) continue;
        out.push({ email, name: employeeName(person), role: "required" });
    }
    return out;
}

// ── The worker ───────────────────────────────────────────────────────────────

const dueWhere = (now) => ({
    calendarSyncStatus: { in: [SESSION_CALENDAR_STATUS.PENDING, SESSION_CALENDAR_STATUS.FAILED] },
    calendarNextAttemptAt: { lte: now },
    OR: [{ calendarClaimExpiresAt: null }, { calendarClaimExpiresAt: { lt: now } }],
});

const heldWhere = (tenantId, id, workerId) => withTenant(tenantId, { id, calendarClaimedBy: workerId });

// Held by this worker AND still the revision it read (a re-mark moves
// calendarNextAttemptAt, so a settle for an older revision matches nothing).
const currentWhere = (tenantId, session, workerId) => ({
    ...heldWhere(tenantId, session.id, workerId),
    calendarNextAttemptAt: session.calendarNextAttemptAt,
});

const RELEASED = Object.freeze({ calendarClaimedBy: null, calendarClaimExpiresAt: null });

const PERSON_SELECT = Object.freeze({ id: true, first_name: true, last_name: true, employee_name: true, work_email: true, email: true });

const SYNC_SELECT = Object.freeze({
    id: true,
    tenantId: true,
    checklistId: true,
    title: true,
    sessionDate: true,
    fromTime: true,
    toTime: true,
    sessionType: true,
    location: true,
    required: true,
    assigneeId: true,
    createdAt: true,
    calendarProvider: true,
    calendarEventId: true,
    calendarSyncAction: true,
    calendarSyncAttempts: true,
    calendarNextAttemptAt: true,
    checklist: { select: { employeeId: true, employee: { select: PERSON_SELECT } } },
});

async function claimRow(tenantId, id, workerId, now) {
    const result = await prisma.onboardingSession.updateMany({
        where: withTenant(tenantId, { id, ...dueWhere(now) }),
        data: { calendarClaimedBy: workerId, calendarClaimExpiresAt: new Date(now.getTime() + CALENDAR_SYNC_LEASE_MS) },
    });
    return Number(result?.count ?? 0) === 1;
}

/**
 * What the row needs now: { action, removeRow, unschedule }. A tombstone
 * cancels and removes the row; an undated session cancels and forgets its
 * event; else create or update by whether an event exists.
 */
export function resolveSessionAction(session) {
    if (isSessionTombstone(session)) return { action: SESSION_CALENDAR_ACTION.CANCEL, removeRow: true, unschedule: false };
    if (!session.sessionDate) return { action: SESSION_CALENDAR_ACTION.CANCEL, removeRow: false, unschedule: true };
    return { action: nextSessionCalendarAction({ calendarEventId: session.calendarEventId }), removeRow: false, unschedule: false };
}

const releaseClaim = (tx, tenantId, id, workerId) =>
    tx.onboardingSession.updateMany({ where: heldWhere(tenantId, id, workerId), data: { ...RELEASED } });

/** Record the outcome while the claim holds; keep a new event's id if it does not. */
async function settleSynced(tenantId, session, workerId, now, { plan, ref, newHireInvited }) {
    const { action, removeRow, unschedule } = plan;
    return tenantTransaction(
        prisma,
        async (tx) => {
            const where = currentWhere(tenantId, session, workerId);
            let count;
            if (removeRow) {
                count = Number((await tx.onboardingSession.deleteMany({ where }))?.count ?? 0);
            } else {
                const linkage = unschedule
                    ? { calendarProvider: null, calendarEventId: null }
                    : ref ? { calendarProvider: ref.provider, calendarEventId: ref.eventId } : {};
                const result = await tx.onboardingSession.updateMany({
                    where,
                    data: {
                        ...linkage,
                        calendarSyncStatus: SESSION_CALENDAR_STATUS.SYNCED,
                        calendarSyncAction: unschedule ? null : action,
                        calendarSyncedAt: now,
                        calendarSyncAttempts: 0,
                        calendarNextAttemptAt: null,
                        calendarLastError: null,
                        ...RELEASED,
                    },
                });
                count = Number(result?.count ?? 0);
            }
            const called = Boolean(ref);
            if (count === 1) {
                if (called) await enqueueHrDomainEvent(tx, sessionCalendarSyncedEvent(session, { action, provider: ref.provider, newHireInvited }));
                return called ? "synced" : "noop";
            }
            // The session changed while the call was in flight. A new event
            // must not be forgotten, or the next pass would create a second.
            if (ref && action === SESSION_CALENDAR_ACTION.CREATE) {
                const linkage = { calendarProvider: ref.provider, calendarEventId: ref.eventId };
                await tx.onboardingSession.updateMany({
                    where: withTenant(tenantId, { id: session.id, calendarEventId: null, calendarSyncAction: SESSION_CALENDAR_ACTION.CREATE }),
                    data: { ...linkage, calendarSyncAction: SESSION_CALENDAR_ACTION.UPDATE },
                });
                await tx.onboardingSession.updateMany({
                    where: withTenant(tenantId, { id: session.id, calendarEventId: null }),
                    data: linkage,
                });
            }
            await releaseClaim(tx, tenantId, session.id, workerId);
            return "superseded";
        },
        { tenantId },
    );
}

async function recordFailure(tenantId, session, workerId, now, { action, err }) {
    const attempts = (session.calendarSyncAttempts ?? 0) + 1;
    const retryable = err instanceof CalendarClientError ? err.retryable : err?.code === NO_ATTENDEES_CODE ? false : true;
    const terminal = !retryable || attempts >= MAX_CALENDAR_SYNC_ATTEMPTS;
    const errorCode = String(err?.code || INTERNAL_ERROR_CODE).slice(0, LAST_ERROR_MAX);
    return tenantTransaction(
        prisma,
        async (tx) => {
            const result = await tx.onboardingSession.updateMany({
                where: currentWhere(tenantId, session, workerId),
                data: {
                    calendarSyncStatus: SESSION_CALENDAR_STATUS.FAILED,
                    calendarSyncAttempts: attempts,
                    calendarLastError: errorCode,
                    calendarNextAttemptAt: terminal ? null : new Date(now.getTime() + calendarSyncBackoffMs(attempts)),
                    ...RELEASED,
                },
            });
            if (Number(result?.count ?? 0) !== 1) {
                await releaseClaim(tx, tenantId, session.id, workerId);
                return "superseded";
            }
            if (terminal) await enqueueHrDomainEvent(tx, sessionCalendarSyncFailedEvent(session, { action, errorCode, attempts }));
            return terminal ? "failed" : "retry";
        },
        { tenantId },
    );
}

// The reply's event reference (the client's own reader is not exported).
function readRef(result, fallback = {}) {
    const provider = result?.provider ?? result?.calendarProvider ?? fallback.provider ?? null;
    const eventId = result?.eventId ?? result?.calendarEventId ?? result?.id ?? fallback.eventId ?? null;
    if (!provider || !eventId) {
        throw new CalendarClientError("The Communication service did not return the event reference", { code: CALENDAR_ERROR.BAD_RESPONSE, retryable: true });
    }
    return { provider: String(provider), eventId: String(eventId) };
}

// The revision a write belongs to: a cancel is named by the event it
// cancels; a create or update by the content it writes, so a retry of the
// same write replays and a changed session is a new write.
function writeVersion(session, content, attendees) {
    return eventFingerprint({
        createdAt: new Date(session.createdAt ?? 0).getTime(),
        start: content.start.toISOString(),
        end: content.end.toISOString(),
        location: content.location,
        title: content.title,
        attendees: attendees.map((a) => a.email).sort(),
    });
}

async function loadHost(tenantId, assigneeId) {
    if (assigneeId == null) return null;
    return prisma.employee.findFirst({ where: { id: assigneeId, tenant_id: tenantId }, select: PERSON_SELECT });
}

async function callProvider(tenantId, session, action, settings) {
    if (action === SESSION_CALENDAR_ACTION.CANCEL) {
        const idempotencyKey = sessionIdempotencyKey({ sessionId: session.id, action, version: eventFingerprint({ eventId: session.calendarEventId }) });
        await callCalendarTool(
            "cancel",
            { tenantId, provider: session.calendarProvider, eventId: session.calendarEventId, sourceRef: sourceRef(session.id), idempotencyKey },
            { tenantId, idempotencyKey },
        );
        return { ref: { provider: session.calendarProvider, eventId: session.calendarEventId }, newHireInvited: false };
    }
    const newHire = session.checklist?.employee ?? null;
    const host = await loadHost(tenantId, session.assigneeId);
    const attendees = sessionAttendees(newHire, host);
    if (!attendees.length) throw fail("Nobody on this session has an email address", 422, NO_ATTENDEES_CODE);
    const content = buildSessionEventContent(session, host, settings);
    const idempotencyKey = sessionIdempotencyKey({ sessionId: session.id, action, version: writeVersion(session, content, attendees) });
    const args = {
        tenantId,
        source: EVENT_SOURCE,
        sourceRef: sourceRef(session.id),
        title: content.title,
        description: content.description,
        start: content.start.toISOString(),
        end: content.end.toISOString(),
        location: content.location,
        attendees,
        idempotencyKey,
    };
    const update = action === SESSION_CALENDAR_ACTION.UPDATE;
    const result = await callCalendarTool(
        update ? "update" : "create",
        update ? { ...args, provider: session.calendarProvider, eventId: session.calendarEventId } : args,
        { tenantId, idempotencyKey },
    );
    const ref = readRef(result, update ? { provider: session.calendarProvider, eventId: session.calendarEventId } : {});
    const hireEmail = employeeEmail(newHire);
    return { ref, newHireInvited: Boolean(hireEmail && attendees.some((a) => a.email === hireEmail)) };
}

/** One claimed row, start to finish. Returns the outcome label. */
async function processRow(tenantId, id, workerId, now, settingsFor) {
    if (!(await claimRow(tenantId, id, workerId, now))) return "raceLost";
    const session = await prisma.onboardingSession.findFirst({ where: heldWhere(tenantId, id, workerId), select: SYNC_SELECT });
    if (!session) return "raceLost";
    const plan = resolveSessionAction(session);
    if (plan.action === SESSION_CALENDAR_ACTION.CANCEL && !session.calendarEventId) {
        return settleSynced(tenantId, session, workerId, now, { plan, ref: null, newHireInvited: false });
    }
    try {
        const settings = plan.action === SESSION_CALENDAR_ACTION.CANCEL ? null : await settingsFor(tenantId);
        const { ref, newHireInvited } = await callProvider(tenantId, session, plan.action, settings);
        return await settleSynced(tenantId, session, workerId, now, { plan, ref, newHireInvited });
    } catch (err) {
        log.warn({ sessionId: id, action: plan.action, code: err?.code ?? null, retryable: err?.retryable ?? null }, "onboarding calendar sync: call failed");
        return recordFailure(tenantId, session, workerId, now, { action: plan.action, err });
    }
}

/**
 * One sync pass. Safe to run concurrently (claims), idempotent, and one bad
 * row never stops the run.
 *
 * @param {{ now?: Date, limit?: number, workerId?: string }} [args]
 * @returns {Promise<object>} counts per outcome, or { skipped: "FLAG_OFF" }
 */
export async function runOnboardingCalendarSyncTick({ now = new Date(), limit, workerId } = {}) {
    if (!isOnboardingCalendarEnabled()) return { skipped: "FLAG_OFF" };
    const at = new Date(now);
    const worker = sanitiseWorkerId(workerId) || generateWorkerId();
    const summary = { scanned: 0, synced: 0, noop: 0, retry: 0, failed: 0, superseded: 0, raceLost: 0, errors: 0 };

    const due = await mcpCtx.run({ system: true }, async () =>
        await prisma.onboardingSession.findMany({
            where: { ...dueWhere(at), tenantId: { not: null } },
            select: { id: true, tenantId: true },
            orderBy: [{ calendarNextAttemptAt: "asc" }, { id: "asc" }],
            take: clampLimit(limit),
        }),
    );
    summary.scanned = due.length;

    // One settings read per tenant per pass (time zone and working day).
    const settingsCache = new Map();
    const settingsFor = async (tenantId) => {
        if (!settingsCache.has(tenantId)) settingsCache.set(tenantId, await getRecruitmentSettings({ tenantId }));
        return settingsCache.get(tenantId);
    };

    for (const row of due) {
        if (!row.tenantId) continue;
        try {
            const outcome = await mcpCtx.run({ user: { tenantId: row.tenantId } }, async () => await processRow(row.tenantId, row.id, worker, at, settingsFor));
            summary[outcome] = (summary[outcome] ?? 0) + 1;
        } catch (err) {
            // The claim lapses on its own, so the row is retried after the lease.
            summary.errors += 1;
            log.error({ sessionId: row.id, errMessage: err?.message }, "onboarding calendar sync: row failed");
        }
    }
    if (summary.scanned) log.info({ ...summary, workerId: worker }, "onboarding calendar sync: tick done");
    return summary;
}

// ── Re-queue one session (hr_onboarding_session_calendar_resync) ────────────

/**
 * Queue one session for a fresh calendar write: CANCEL for a deleted
 * session's tombstone, UPDATE when an event exists, else CREATE; attempts
 * reset. The way to retry a FAILED invite once the cause is fixed.
 */
export async function requeueOnboardingSessionCalendarSync({ sessionId, tenantId, now = new Date() } = {}) {
    if (!tenantId) throw fail("Tenant context is required", 400, "HR-TENANT-REQUIRED");
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) throw fail("Onboarding session not found", 404, "HR-ONBOARDING-SESSION-NOT-FOUND");

    return tenantTransaction(
        prisma,
        async (tx) => {
            const session = await tx.onboardingSession.findFirst({
                where: withTenant(tenantId, { id }),
                select: { id: true, sessionDate: true, calendarEventId: true, calendarSyncAction: true },
            });
            if (!session) throw fail("Onboarding session not found", 404, "HR-ONBOARDING-SESSION-NOT-FOUND");
            const tombstone = isSessionTombstone(session);
            if (!tombstone && !session.sessionDate && !session.calendarEventId) {
                throw fail("The session has no date, so there is no invite to send", 409, "HR-ONBOARDING-SESSION-UNDATED");
            }
            const action = nextSessionCalendarAction({ calendarEventId: session.calendarEventId, cancel: tombstone });
            await tx.onboardingSession.update({ where: { id: session.id }, data: sessionCalendarMark(action, now) });
            return {
                sessionId: session.id,
                calendarSyncStatus: SESSION_CALENDAR_STATUS.PENDING,
                calendarSyncAction: action,
                calendarSyncEnabled: isOnboardingCalendarEnabled(),
            };
        },
        { tenantId },
    );
}

export default { runOnboardingCalendarSyncTick, requeueOnboardingSessionCalendarSync };

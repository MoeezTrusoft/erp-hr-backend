// Recruitment Phase 4 — the onboarding session calendar worker: the flags,
// CREATE with the new hire and the host as attendees (and nothing else in
// the content), UPDATE, retries with the interview worker's backoff up to its
// ceiling, the deleted-session tombstone, the undated session, a change
// landing mid-call, and the re-sync service.
//
// The real Communication client runs against a mocked axios, so the
// JSON-RPC body and the error classification are exercised end to end.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createOnboardingDb } from "./helpers/onboarding-sessions.fake.js";
import { createEventRecorder } from "./helpers/interview-scheduling.fake.js";

const { db, state, addSession } = createOnboardingDb();
const { events, enqueueHrDomainEvent } = createEventRecorder();
const axiosMock = { request: jest.fn(), create: jest.fn(() => axiosMock) };

jest.unstable_mockModule("axios", () => ({ default: axiosMock }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/candidate-privacy.service.js", () => ({ assertCommunicationsAllowed: jest.fn() }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));

const sync = await import("../../../src/services/onboarding-calendar-sync.service.js");
const { MAX_CALENDAR_SYNC_ATTEMPTS, CALENDAR_SYNC_BACKOFF_MS } = await import("../../../src/services/interview-calendar-sync.service.js");
const { sessionCalendarMark } = await import("../../../src/lib/onboarding-sessions.util.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-10-20T08:00:00.000Z");
const MIN = 60_000;
const at = (ms) => new Date(T0.getTime() + ms);

const rpcOk = (data) => ({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(data) }] } }) });
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: "" } });
const toolCalls = () => axiosMock.request.mock.calls.map(([req]) => req.data.params);

function seed() {
    for (const key of Object.keys(state)) state[key] = [];
    state.employees.push(
        { id: 30, tenant_id: TENANT, first_name: "Ayesha", last_name: "Malik", work_email: null, email: "ayesha@example.com" },
        { id: 7, tenant_id: TENANT, first_name: "Rabia", last_name: "Khan", work_email: "rabia@corp.test", email: "rabia@mail.test" },
        { id: 50, tenant_id: OTHER, first_name: "Other", last_name: "Hire", work_email: "o@other.test" },
    );
    state.checklists.push(
        { id: 70, tenantId: TENANT, employeeId: 30, notes: "Visa pending; salary 900k" },
        { id: 71, tenantId: OTHER, employeeId: 50 },
    );
}

const session = (over = {}) =>
    addSession({
        id: over.id ?? 400,
        tenantId: TENANT,
        checklistId: 70,
        templateKey: "welcome-hr-orientation",
        title: "Welcome and HR orientation",
        sessionType: "orientation",
        sessionDate: new Date("2026-10-26T00:00:00Z"),
        fromTime: "09:30",
        toTime: "11:00",
        location: "Room 2",
        required: true,
        assigneeId: 7,
        createdAt: new Date("2026-10-19T10:00:00Z"),
        ...sessionCalendarMark("CREATE", T0),
        ...over,
    });

const row = (id = 400) => state.sessions.find((s) => s.id === id);
const tick = (now, workerId = "worker-a") => sync.runOnboardingCalendarSyncTick({ now, workerId });

beforeEach(() => {
    seed();
    events.length = 0;
    db.contextLog.length = 0;
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_CALENDAR_SYNC = "true";
    process.env.HR_ONBOARDING_AUTOMATION = "true";
    axiosMock.request.mockImplementation(async () => rpcOk({ provider: "GOOGLE_WORKSPACE", eventId: "evt-1" }));
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_CALENDAR_SYNC;
    delete process.env.HR_ONBOARDING_AUTOMATION;
});

describe("the flags", () => {
    it.each([
        ["calendarSync off", { HR_RECRUITMENT_CALENDAR_SYNC: "false" }],
        ["onboardingAutomation off", { HR_ONBOARDING_AUTOMATION: "false" }],
    ])("%s: nothing is claimed or called, the mark stays PENDING", async (_label, env) => {
        Object.assign(process.env, env);
        session();
        await expect(tick(at(0))).resolves.toEqual({ skipped: "FLAG_OFF" });
        expect(axiosMock.request).not.toHaveBeenCalled();
        expect(row().calendarSyncStatus).toBe("PENDING");
    });
});

describe("CREATE", () => {
    it("invites the new hire (personal email when no work email) and the host, records the linkage, announces it", async () => {
        session();
        await expect(tick(at(0))).resolves.toMatchObject({ scanned: 1, synced: 1 });

        const [call] = toolCalls();
        expect(call.name).toBe("communication_calendar_event_create");
        const args = call.arguments;
        expect(args.attendees).toEqual([
            { email: "ayesha@example.com", name: "Ayesha Malik", role: "required" },
            { email: "rabia@corp.test", name: "Rabia Khan", role: "required" },
        ]);
        expect(args).toMatchObject({
            tenantId: TENANT,
            source: "hr.onboarding.session",
            sourceRef: "hr-onboarding-session-400",
            title: "Welcome and HR orientation",
            // 09:30 to 11:00 in Asia/Karachi (the settings default).
            start: "2026-10-26T04:30:00.000Z",
            end: "2026-10-26T06:00:00.000Z",
            location: "Room 2",
        });
        expect(args.description).toContain("Host: Rabia Khan");
        expect(args.description).toContain("Attendance: required");
        expect(args.idempotencyKey).toMatch(/^hr-onboarding-session-400-CREATE-[0-9a-f]{16}$/);
        // Checklist notes never reach the calendar.
        expect(JSON.stringify(args)).not.toMatch(/Visa|900k/);

        expect(row()).toMatchObject({
            calendarSyncStatus: "SYNCED",
            calendarSyncAction: "CREATE",
            calendarProvider: "GOOGLE_WORKSPACE",
            calendarEventId: "evt-1",
            calendarSyncAttempts: 0,
            calendarNextAttemptAt: null,
            calendarClaimedBy: null,
            calendarLastError: null,
        });
        expect(events).toEqual([
            expect.objectContaining({
                eventName: "hr.onboarding.session_calendar_synced.v1",
                tenantId: TENANT,
                aggregateType: "OnboardingSession",
                aggregateId: 400,
                payload: { sessionId: "400", checklistId: "70", employeeId: "30", assigneeId: "7", action: "CREATE", calendarProvider: "GOOGLE_WORKSPACE", newHireInvited: true },
            }),
        ]);
    });

    it("scans across tenants under SYSTEM and works each row under its own tenant", async () => {
        session();
        session({ id: 401, tenantId: OTHER, checklistId: 71, assigneeId: null });
        await expect(tick(at(0))).resolves.toMatchObject({ scanned: 2, synced: 2 });
        const scan = db.contextLog.find((c) => c.model === "onboardingSession" && c.op === "findMany");
        expect(scan.system).toBe(true);
        const claims = db.contextLog.filter((c) => c.op === "updateMany" && !c.system);
        expect(new Set(claims.map((c) => c.tenantId))).toEqual(new Set([TENANT, OTHER]));
        expect(toolCalls()[1].arguments.attendees.map((a) => a.email)).toEqual(["o@other.test"]);
    });

    it("leaves a row alone while another worker's claim is live", async () => {
        session({ calendarClaimedBy: "worker-b", calendarClaimExpiresAt: at(2 * MIN) });
        await expect(tick(at(0))).resolves.toMatchObject({ scanned: 0 });
        expect(axiosMock.request).not.toHaveBeenCalled();
    });

    it("nobody with an address: FAILED at once with the code, announced", async () => {
        state.employees[0].email = null;
        session({ assigneeId: null });
        await expect(tick(at(0))).resolves.toMatchObject({ failed: 1 });
        expect(axiosMock.request).not.toHaveBeenCalled();
        expect(row()).toMatchObject({ calendarSyncStatus: "FAILED", calendarLastError: "HR-ONBOARDING-CALENDAR-NO-ATTENDEES", calendarNextAttemptAt: null });
        expect(events[0]).toMatchObject({ eventName: "hr.onboarding.session_calendar_sync_failed.v1", payload: { action: "CREATE", errorCode: "HR-ONBOARDING-CALENDAR-NO-ATTENDEES", attempts: 1 } });
    });
});

describe("UPDATE", () => {
    it("an existing event is updated in place with the same provider and id", async () => {
        session({ calendarProvider: "GOOGLE_WORKSPACE", calendarEventId: "evt-9", ...sessionCalendarMark("UPDATE", T0) });
        axiosMock.request.mockImplementation(async () => rpcOk({}));
        await expect(tick(at(0))).resolves.toMatchObject({ synced: 1 });
        const [call] = toolCalls();
        expect(call.name).toBe("communication_calendar_event_update");
        expect(call.arguments).toMatchObject({ provider: "GOOGLE_WORKSPACE", eventId: "evt-9" });
        expect(row()).toMatchObject({ calendarSyncStatus: "SYNCED", calendarEventId: "evt-9" });
    });

    it("a CREATE mark on a row that already has an event updates rather than duplicates", async () => {
        session({ calendarProvider: "GOOGLE_WORKSPACE", calendarEventId: "evt-9" });
        await tick(at(0));
        expect(toolCalls()[0].name).toBe("communication_calendar_event_update");
    });
});

describe("retries", () => {
    it("backs off with the interview worker's schedule and gives up at its ceiling", async () => {
        session();
        axiosMock.request.mockImplementation(async () => {
            throw httpError(503);
        });
        let now = at(0);
        for (let attempt = 1; attempt < MAX_CALENDAR_SYNC_ATTEMPTS; attempt += 1) {
            await expect(tick(now)).resolves.toMatchObject({ retry: 1 });
            expect(row()).toMatchObject({ calendarSyncStatus: "FAILED", calendarSyncAttempts: attempt, calendarLastError: "HR-RECRUITMENT-CALENDAR-UNAVAILABLE" });
            expect(row().calendarNextAttemptAt).toEqual(new Date(now.getTime() + CALENDAR_SYNC_BACKOFF_MS[attempt - 1]));
            // Not due yet: nothing happens.
            await expect(tick(new Date(now.getTime() + 1000))).resolves.toMatchObject({ scanned: 0 });
            now = row().calendarNextAttemptAt;
        }
        expect(events).toEqual([]);
        await expect(tick(now)).resolves.toMatchObject({ failed: 1 });
        expect(row()).toMatchObject({ calendarSyncAttempts: MAX_CALENDAR_SYNC_ATTEMPTS, calendarNextAttemptAt: null });
        expect(events).toEqual([expect.objectContaining({ eventName: "hr.onboarding.session_calendar_sync_failed.v1" })]);
    });

    it("a rejected request is FAILED at once (retrying cannot help)", async () => {
        session();
        axiosMock.request.mockImplementation(async () => {
            throw httpError(400);
        });
        await expect(tick(at(0))).resolves.toMatchObject({ failed: 1 });
        expect(row()).toMatchObject({ calendarSyncAttempts: 1, calendarLastError: "HR-RECRUITMENT-CALENDAR-REJECTED" });
    });
});

describe("deleted and undated sessions", () => {
    it("a tombstone cancels the event, then the row goes", async () => {
        session({ calendarProvider: "GOOGLE_WORKSPACE", calendarEventId: "evt-9", ...sessionCalendarMark("CANCEL", T0) });
        axiosMock.request.mockImplementation(async () => rpcOk({ cancelled: true }));
        await expect(tick(at(0))).resolves.toMatchObject({ synced: 1 });
        const [call] = toolCalls();
        expect(call.name).toBe("communication_calendar_event_cancel");
        expect(call.arguments).toMatchObject({ provider: "GOOGLE_WORKSPACE", eventId: "evt-9", sourceRef: "hr-onboarding-session-400" });
        expect(row()).toBeUndefined();
        expect(events[0]).toMatchObject({ eventName: "hr.onboarding.session_calendar_synced.v1", payload: { action: "CANCEL" } });
    });

    it("a tombstone with no event is removed without a call", async () => {
        session(sessionCalendarMark("CANCEL", T0));
        await expect(tick(at(0))).resolves.toMatchObject({ noop: 1 });
        expect(axiosMock.request).not.toHaveBeenCalled();
        expect(row()).toBeUndefined();
        expect(events).toEqual([]);
    });

    it("a failed cancel keeps the tombstone for the retry", async () => {
        session({ calendarProvider: "GOOGLE_WORKSPACE", calendarEventId: "evt-9", ...sessionCalendarMark("CANCEL", T0) });
        axiosMock.request.mockImplementation(async () => {
            throw httpError(502);
        });
        await expect(tick(at(0))).resolves.toMatchObject({ retry: 1 });
        expect(row()).toMatchObject({ calendarSyncAction: "CANCEL", calendarSyncStatus: "FAILED" });
    });

    it("a session whose date was cleared cancels its event and forgets it", async () => {
        session({ sessionDate: null, calendarProvider: "GOOGLE_WORKSPACE", calendarEventId: "evt-9", ...sessionCalendarMark("UPDATE", T0) });
        axiosMock.request.mockImplementation(async () => rpcOk({ cancelled: true }));
        await expect(tick(at(0))).resolves.toMatchObject({ synced: 1 });
        expect(toolCalls()[0].name).toBe("communication_calendar_event_cancel");
        expect(row()).toMatchObject({ calendarSyncStatus: "SYNCED", calendarSyncAction: null, calendarEventId: null, calendarProvider: null });
    });
});

describe("a change landing mid-call", () => {
    it("keeps the new event id, releases the claim and leaves the newer mark for the next pass", async () => {
        session();
        axiosMock.request.mockImplementationOnce(async () => {
            // HR moves the session while the create is in flight.
            Object.assign(row(), { fromTime: "10:00", ...sessionCalendarMark("UPDATE", at(MIN / 2)) });
            return rpcOk({ provider: "GOOGLE_WORKSPACE", eventId: "evt-1" });
        });
        await expect(tick(at(0))).resolves.toMatchObject({ superseded: 1 });
        expect(row()).toMatchObject({ calendarEventId: "evt-1", calendarSyncStatus: "PENDING", calendarClaimedBy: null });

        axiosMock.request.mockImplementation(async () => rpcOk({}));
        await expect(tick(at(MIN))).resolves.toMatchObject({ synced: 1 });
        expect(toolCalls()[1].name).toBe("communication_calendar_event_update");
        expect(toolCalls()[1].arguments.start).toBe("2026-10-26T05:00:00.000Z");
    });

    it("an isolated row error never stops the run", async () => {
        session();
        session({ id: 401, templateKey: "it-setup" });
        db.onboardingSession.findFirst.mockImplementationOnce(() => Promise.reject(new Error("db blip")));
        await expect(tick(at(0))).resolves.toMatchObject({ scanned: 2, errors: 1, synced: 1 });
    });
});

describe("requeueOnboardingSessionCalendarSync", () => {
    const requeue = (sessionId, tenantId = TENANT) =>
        mcpCtx.run({ user: { tenantId } }, async () => await sync.requeueOnboardingSessionCalendarSync({ sessionId, tenantId, now: at(5 * MIN) }));

    it("a FAILED invite is queued afresh: CREATE without an event, UPDATE with one, CANCEL for a tombstone", async () => {
        session({ calendarSyncStatus: "FAILED", calendarSyncAttempts: 6, calendarNextAttemptAt: null, calendarLastError: "X" });
        await expect(requeue(400)).resolves.toEqual({ sessionId: 400, calendarSyncStatus: "PENDING", calendarSyncAction: "CREATE", calendarSyncEnabled: true });
        expect(row()).toMatchObject({ calendarSyncStatus: "PENDING", calendarSyncAttempts: 0, calendarLastError: null });
        expect(row().calendarNextAttemptAt).toEqual(at(5 * MIN));

        session({ id: 401, templateKey: "it-setup", calendarEventId: "evt-2", calendarSyncStatus: "SYNCED" });
        await expect(requeue(401)).resolves.toMatchObject({ calendarSyncAction: "UPDATE" });
        session({ id: 402, templateKey: "x", calendarEventId: "evt-3", calendarSyncAction: "CANCEL", calendarSyncStatus: "FAILED" });
        await expect(requeue(402)).resolves.toMatchObject({ calendarSyncAction: "CANCEL" });
    });

    it("another tenant's session is not found; an undated session without an event has nothing to send", async () => {
        session({ id: 401, tenantId: OTHER, checklistId: 71 });
        await expect(requeue(401)).rejects.toMatchObject({ status: 404, code: "HR-ONBOARDING-SESSION-NOT-FOUND" });
        session({ sessionDate: null, calendarSyncStatus: null, calendarSyncAction: null });
        await expect(requeue(400)).rejects.toMatchObject({ status: 409, code: "HR-ONBOARDING-SESSION-UNDATED" });
        await expect(requeue("abc")).rejects.toMatchObject({ status: 404 });
    });
});

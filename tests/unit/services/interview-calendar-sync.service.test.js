// Recruitment Phase 3a — the interview calendar sync worker: claims, the
// event it writes (and what it must leave out), the candidate invite under
// do-not-contact, retries with backoff up to the ceiling, the CANCEL no-op,
// a change landing mid-call, and the re-sync tool's service.
//
// The real Communication client runs against a mocked axios, so the
// JSON-RPC body and the error classification are exercised end to end.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createSchedulingDb, createEventRecorder } from "./helpers/interview-scheduling.fake.js";

const { db, state } = createSchedulingDb();
const { events, enqueueHrDomainEvent } = createEventRecorder();
const axiosMock = { request: jest.fn(), create: jest.fn(() => axiosMock) };
const assertCommunicationsAllowed = jest.fn();

jest.unstable_mockModule("axios", () => ({ default: axiosMock }));
jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/config/prisma.js", () => ({ default: db }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent }));
jest.unstable_mockModule("../../../src/services/candidatePrivacy.service.js", () => ({ assertCommunicationsAllowed }));
jest.unstable_mockModule("../../../src/utils/logs.js", () => ({ logAction: jest.fn(async () => undefined) }));

const sync = await import("../../../src/services/interview-calendar-sync.service.js");
const { calendarSyncMark } = await import("../../../src/services/interviewSchedule.service.js");
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
        { id: 3, tenant_id: TENANT, first_name: "Sara", last_name: "Khan", employee_name: "Sara Khan", work_email: "sara@corp.test", email: "sara.personal@mail.test" },
        { id: 4, tenant_id: TENANT, first_name: "Ali", last_name: null, employee_name: "Ali Raza", work_email: null, email: "ali@corp.test" },
    );
    state.requisitions.push({ id: 21, tenantId: TENANT, title: "Backend Engineer", requestedById: 7, approvedById: null });
    state.candidates.push({ id: 5, tenantId: TENANT, firstName: "Ayesha", lastName: "Malik", email: "ayesha@example.com", anonymizedAt: null });
    state.applications.push({ id: 9, tenantId: TENANT, candidateId: 5, jobRequisitionId: 21, stage: "interview" });
}

function addInterview(over = {}) {
    const row = {
        id: over.id ?? 40,
        tenantId: TENANT,
        applicationId: 9,
        interviewType: "TECHNICAL",
        scheduledAt: new Date("2026-10-22T05:00:00Z"),
        durationMinutes: 60,
        location: "https://meet.example/abc",
        notes: "Salary expectation 900k; strong on SQL",
        status: "SCHEDULED",
        decision: null,
        created_at: new Date("2026-10-19T10:00:00Z"),
        updated_at: new Date("2026-10-19T10:00:00Z"),
        calendarProvider: null,
        calendarEventId: null,
        calendarSyncedAt: null,
        calendarClaimedBy: null,
        calendarClaimExpiresAt: null,
        ...calendarSyncMark("CREATE", T0),
        ...over,
    };
    state.interviews.push(row);
    if (!state.interviewers.some((i) => i.interviewId === row.id)) {
        state.interviewers.push({ interviewId: row.id, employeeId: 3, tenantId: row.tenantId }, { interviewId: row.id, employeeId: 4, tenantId: row.tenantId });
    }
    return row;
}

const row = (id = 40) => state.interviews.find((i) => i.id === id);
const tick = (now, workerId = "worker-a") => sync.runInterviewCalendarSyncTick({ now, workerId });

beforeEach(() => {
    seed();
    events.length = 0;
    db.contextLog.length = 0;
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_CALENDAR_SYNC = "true";
    assertCommunicationsAllowed.mockImplementation(async () => ({ allowed: true, email: "ayesha@example.com" }));
    axiosMock.request.mockImplementation(async () => rpcOk({ provider: "GOOGLE_WORKSPACE", eventId: "evt-1" }));
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_CALENDAR_SYNC;
});

describe("the flag", () => {
    it("off: nothing is claimed or called, the mark stays PENDING", async () => {
        process.env.HR_RECRUITMENT_CALENDAR_SYNC = "false";
        addInterview();
        await expect(tick(at(0))).resolves.toEqual({ skipped: "FLAG_OFF" });
        expect(axiosMock.request).not.toHaveBeenCalled();
        expect(row().calendarSyncStatus).toBe("PENDING");
    });
});

describe("CREATE", () => {
    it("writes the event, records the linkage and announces it", async () => {
        addInterview();
        const summary = await tick(at(0));
        expect(summary).toMatchObject({ scanned: 1, synced: 1 });

        const [call] = toolCalls();
        expect(call.name).toBe("communication_calendar_event_create");
        expect(call.arguments.attendees.map((a) => a.email)).toEqual(["sara@corp.test", "ali@corp.test", "ayesha@example.com"]);
        expect(call.arguments.title).toBe("Technical interview: Backend Engineer");
        expect(call.arguments.start).toBe("2026-10-22T05:00:00.000Z");
        expect(call.arguments.end).toBe("2026-10-22T06:00:00.000Z");
        expect(call.arguments.location).toBe("https://meet.example/abc");
        expect(call.arguments.description).toContain("Panel: Sara Khan, Ali Raza");
        expect(call.arguments.idempotencyKey).toBe(`hr-interview-40-CREATE-${Date.parse("2026-10-19T10:00:00Z")}`);
        // Never notes, salary or the candidate's details in the content.
        const content = `${call.arguments.title}\n${call.arguments.description}`;
        expect(content).not.toMatch(/900k|SQL|Ayesha|ayesha/i);

        expect(row()).toMatchObject({
            calendarSyncStatus: "SYNCED",
            calendarProvider: "GOOGLE_WORKSPACE",
            calendarEventId: "evt-1",
            calendarSyncAttempts: 0,
            calendarNextAttemptAt: null,
            calendarClaimedBy: null,
            calendarLastError: null,
        });
        expect(row().calendarSyncedAt).toEqual(at(0));
        expect(events).toEqual([
            expect.objectContaining({
                eventName: "hr.recruitment.interview_calendar_synced.v1",
                tenantId: TENANT,
                payload: { interviewId: "40", applicationId: "9", action: "CREATE", calendarProvider: "GOOGLE_WORKSPACE", candidateInvited: true },
            }),
        ]);
    });

    it("runs the scan under SYSTEM and everything else under the row's tenant", async () => {
        addInterview();
        await tick(at(0));
        const [scan, ...rest] = db.contextLog;
        expect(scan).toMatchObject({ model: "interview", op: "findMany", system: true });
        expect(rest.length).toBeGreaterThan(0);
        expect(rest.every((q) => q.tenantId === TENANT && !q.system)).toBe(true);
    });

    it("skips the candidate invite for a do-not-contact candidate, and still writes the panel's event", async () => {
        assertCommunicationsAllowed.mockRejectedValue(Object.assign(new Error("blocked"), { status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" }));
        addInterview();
        await tick(at(0));
        const [call] = toolCalls();
        expect(call.arguments.attendees.map((a) => a.email)).toEqual(["sara@corp.test", "ali@corp.test"]);
        expect(JSON.stringify(call.arguments)).not.toContain("ayesha@example.com");
        expect(assertCommunicationsAllowed).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, candidateId: 5, purpose: "PROCESSING" }));
        expect(events[0].payload.candidateInvited).toBe(false);
        expect(row().calendarSyncStatus).toBe("SYNCED");
    });

    it("an anonymized candidate is never invited", async () => {
        state.candidates[0].anonymizedAt = new Date("2026-10-01T00:00:00Z");
        addInterview();
        await tick(at(0));
        expect(toolCalls()[0].arguments.attendees.map((a) => a.email)).toEqual(["sara@corp.test", "ali@corp.test"]);
        expect(assertCommunicationsAllowed).not.toHaveBeenCalled();
    });
});

describe("UPDATE and CANCEL", () => {
    it("updates the existing provider event", async () => {
        addInterview({ calendarProvider: "GOOGLE_WORKSPACE", calendarEventId: "evt-1", ...calendarSyncMark("UPDATE", T0) });
        axiosMock.request.mockImplementation(async () => rpcOk({ updated: true }));
        await tick(at(0));
        const [call] = toolCalls();
        expect(call.name).toBe("communication_calendar_event_update");
        expect(call.arguments).toMatchObject({ provider: "GOOGLE_WORKSPACE", eventId: "evt-1" });
        expect(call.arguments.idempotencyKey).toMatch(/^hr-interview-40-UPDATE-[0-9a-f]{16}$/);
        expect(row()).toMatchObject({ calendarSyncStatus: "SYNCED", calendarEventId: "evt-1" });
    });

    it("a CREATE for an interview that already has an event updates it instead", async () => {
        addInterview({ calendarProvider: "GOOGLE_WORKSPACE", calendarEventId: "evt-1" });
        await tick(at(0));
        expect(toolCalls()[0].name).toBe("communication_calendar_event_update");
    });

    it("cancels the provider event of a cancelled interview", async () => {
        addInterview({ status: "CANCELLED", calendarProvider: "GOOGLE_WORKSPACE", calendarEventId: "evt-1", ...calendarSyncMark("CANCEL", T0) });
        axiosMock.request.mockImplementation(async () => rpcOk({ cancelled: true }));
        await tick(at(0));
        const [call] = toolCalls();
        expect(call.name).toBe("communication_calendar_event_cancel");
        expect(call.arguments).toMatchObject({ provider: "GOOGLE_WORKSPACE", eventId: "evt-1" });
        expect(call.arguments).not.toHaveProperty("attendees");
        expect(row().calendarSyncStatus).toBe("SYNCED");
        expect(events[0].payload.action).toBe("CANCEL");
    });

    it("a CANCEL with no event is a no-op SYNCED: no call, no event", async () => {
        addInterview({ status: "CANCELLED", ...calendarSyncMark("CANCEL", T0) });
        const summary = await tick(at(0));
        expect(summary).toMatchObject({ noop: 1 });
        expect(axiosMock.request).not.toHaveBeenCalled();
        expect(row()).toMatchObject({ calendarSyncStatus: "SYNCED", calendarEventId: null, calendarClaimedBy: null });
        expect(events).toEqual([]);
    });

    it("a NO_SHOW interview always cancels, whatever action was stored", async () => {
        addInterview({ status: "NO_SHOW", calendarProvider: "P", calendarEventId: "e-1", ...calendarSyncMark("UPDATE", T0) });
        axiosMock.request.mockImplementation(async () => rpcOk({ cancelled: true }));
        await tick(at(0));
        expect(toolCalls()[0].name).toBe("communication_calendar_event_cancel");
    });
});

describe("failures, backoff and the ceiling", () => {
    it("retries with 1m, 5m, 30m, 2h, 6h and fails for good after the 6th attempt", async () => {
        addInterview();
        axiosMock.request.mockRejectedValue(httpError(503));
        const delays = [MIN, 5 * MIN, 30 * MIN, 120 * MIN, 360 * MIN];
        let now = at(0);
        for (let attempt = 1; attempt <= 5; attempt += 1) {
            const summary = await tick(now);
            expect(summary).toMatchObject({ retry: 1 });
            expect(row()).toMatchObject({
                calendarSyncStatus: "FAILED",
                calendarSyncAttempts: attempt,
                calendarLastError: "HR-RECRUITMENT-CALENDAR-UNAVAILABLE",
                calendarClaimedBy: null,
            });
            const next = new Date(now.getTime() + delays[attempt - 1]);
            expect(row().calendarNextAttemptAt).toEqual(next);
            // Not due a moment before the backoff ends.
            await expect(tick(new Date(next.getTime() - 1000))).resolves.toMatchObject({ scanned: 0 });
            now = next;
        }
        const last = await tick(now);
        expect(last).toMatchObject({ failed: 1 });
        expect(row()).toMatchObject({ calendarSyncStatus: "FAILED", calendarSyncAttempts: 6, calendarNextAttemptAt: null });
        expect(events).toEqual([
            expect.objectContaining({
                eventName: "hr.recruitment.interview_calendar_sync_failed.v1",
                payload: { interviewId: "40", applicationId: "9", action: "CREATE", errorCode: "HR-RECRUITMENT-CALENDAR-UNAVAILABLE", attempts: 6 },
            }),
        ]);
        await expect(tick(at(48 * 60 * MIN))).resolves.toMatchObject({ scanned: 0 });
        expect(sync.calendarSyncBackoffMs(9)).toBe(360 * MIN);
    });

    it("a non-retryable refusal fails at once, storing the code only", async () => {
        addInterview();
        axiosMock.request.mockRejectedValue(Object.assign(httpError(400), { response: { status: 400, data: "attendee mailbox x@y rejected" } }));
        const summary = await tick(at(0));
        expect(summary).toMatchObject({ failed: 1 });
        expect(row()).toMatchObject({ calendarSyncStatus: "FAILED", calendarSyncAttempts: 1, calendarNextAttemptAt: null, calendarLastError: "HR-RECRUITMENT-CALENDAR-REJECTED" });
        expect(events[0].eventName).toBe("hr.recruitment.interview_calendar_sync_failed.v1");
    });

    it("a timeout is retryable", async () => {
        addInterview();
        axiosMock.request.mockRejectedValue(Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" }));
        await tick(at(0));
        expect(row()).toMatchObject({ calendarSyncStatus: "FAILED", calendarSyncAttempts: 1, calendarLastError: "HR-RECRUITMENT-CALENDAR-TIMEOUT" });
        expect(row().calendarNextAttemptAt).toEqual(at(MIN));
    });
});

describe("claims", () => {
    it("two overlapping ticks write one event", async () => {
        addInterview();
        const [a, b] = await Promise.all([tick(at(0), "worker-a"), tick(at(0), "worker-b")]);
        expect(axiosMock.request).toHaveBeenCalledTimes(1);
        expect((a.synced ?? 0) + (b.synced ?? 0)).toBe(1);
        expect((a.raceLost ?? 0) + (b.raceLost ?? 0)).toBe(1);
    });

    it("a live claim hides the row; an expired one does not", async () => {
        addInterview({ calendarClaimedBy: "dead-worker", calendarClaimExpiresAt: at(2 * MIN) });
        await expect(tick(at(0))).resolves.toMatchObject({ scanned: 0 });
        await expect(tick(at(3 * MIN))).resolves.toMatchObject({ scanned: 1, synced: 1 });
    });

    it("a pre-Phase-3a PENDING row (no next attempt time) is not picked up", async () => {
        addInterview({ calendarSyncAction: null, calendarNextAttemptAt: null });
        await expect(tick(at(0))).resolves.toMatchObject({ scanned: 0 });
    });

    it("a tenantless row is never scanned", async () => {
        addInterview({ tenantId: null });
        await expect(tick(at(0))).resolves.toMatchObject({ scanned: 0 });
    });
});

describe("a change landing while the call is in flight", () => {
    it("keeps the new event id, releases the claim and leaves the newer mark for the next pass", async () => {
        addInterview();
        axiosMock.request.mockImplementationOnce(async () => {
            // The recruiter moves the interview while the create is running.
            Object.assign(row(), { scheduledAt: new Date("2026-10-23T05:00:00Z"), ...calendarSyncMark("CREATE", at(10_000)) });
            return rpcOk({ provider: "GOOGLE_WORKSPACE", eventId: "evt-1" });
        });
        const summary = await tick(at(0));
        expect(summary).toMatchObject({ superseded: 1 });
        expect(row()).toMatchObject({
            calendarSyncStatus: "PENDING",
            calendarSyncAction: "UPDATE",
            calendarEventId: "evt-1",
            calendarProvider: "GOOGLE_WORKSPACE",
            calendarClaimedBy: null,
        });
        expect(events).toEqual([]);

        axiosMock.request.mockImplementation(async () => rpcOk({ updated: true }));
        await tick(at(20_000));
        const second = toolCalls()[1];
        expect(second.name).toBe("communication_calendar_event_update");
        expect(second.arguments.start).toBe("2026-10-23T05:00:00.000Z");
        expect(row().calendarSyncStatus).toBe("SYNCED");
    });
});

describe("requeueInterviewCalendarSync (hr_interview_calendar_resync)", () => {
    const ORG = { level: "ORG", unrestricted: true, employeeId: 1 };
    const MANAGER = (id) => ({ level: "MANAGED", unrestricted: false, employeeId: id });
    const run = (args) => mcpCtx.run({ user: { tenantId: TENANT } }, async () => await sync.requeueInterviewCalendarSync({ tenantId: TENANT, now: at(0), ...args }));

    it("re-queues a FAILED interview as an UPDATE when it has an event", async () => {
        addInterview({ calendarEventId: "evt-1", calendarSyncStatus: "FAILED", calendarSyncAttempts: 6, calendarNextAttemptAt: null, calendarLastError: "X" });
        const res = await run({ interviewId: 40, scope: ORG });
        expect(res).toEqual({ interviewId: 40, calendarSyncStatus: "PENDING", calendarSyncAction: "UPDATE", calendarSyncEnabled: true });
        expect(row()).toMatchObject({ calendarSyncAttempts: 0, calendarLastError: null, calendarNextAttemptAt: at(0) });
    });

    it("an ended interview re-queues a CANCEL", async () => {
        addInterview({ status: "CANCELLED", calendarEventId: "evt-1" });
        await expect(run({ interviewId: 40, scope: ORG })).resolves.toMatchObject({ calendarSyncAction: "CANCEL" });
    });

    it("a hiring manager can re-queue only their own requisition's interview", async () => {
        addInterview();
        await expect(run({ interviewId: 40, scope: MANAGER(7) })).resolves.toMatchObject({ calendarSyncAction: "CREATE" });
        await expect(run({ interviewId: 40, scope: MANAGER(8) })).rejects.toMatchObject({ status: 404 });
    });

    it("interviewers and finance cannot, and another tenant's interview is not found", async () => {
        addInterview();
        await expect(run({ interviewId: 40, scope: { level: "ASSIGNED", unrestricted: false, employeeId: 3 } })).rejects.toMatchObject({
            status: 403,
            code: "HR-RECRUITMENT-CALENDAR-FORBIDDEN",
        });
        addInterview({ id: 41, tenantId: OTHER });
        await expect(run({ interviewId: 41, scope: ORG })).rejects.toMatchObject({ status: 404 });
    });
});

describe("buildCalendarEventContent", () => {
    it("uses only the allowed fields", () => {
        const content = sync.buildCalendarEventContent({
            interviewType: "PHONE_SCREEN",
            scheduledAt: "2026-10-22T05:00:00Z",
            durationMinutes: 30,
            location: null,
            notes: "do not leak",
            decision: "REJECTED",
            interviewers: [{ employee: { first_name: "Sara", last_name: "Khan" } }],
            application: { jobRequisition: { title: "Analyst", salaryMax: 123 }, candidate: { email: "c@x.test" } },
        });
        expect(content.title).toBe("Phone screen interview: Analyst");
        expect(content.description).toBe("Interview type: Phone screen\nPosition: Analyst\nTime: 2026-10-22T05:00:00.000Z to 2026-10-22T05:30:00.000Z\nPanel: Sara Khan");
        expect(content.end.toISOString()).toBe("2026-10-22T05:30:00.000Z");
    });
});

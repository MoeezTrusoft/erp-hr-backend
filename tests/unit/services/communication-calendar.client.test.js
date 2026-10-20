// Recruitment Phase 3a — the Communication calendar client: the JSON-RPC
// call it makes, the idempotency key, and how each failure is classified.
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

import {
    CALENDAR_ERROR,
    CALENDAR_TOOL_DEFAULTS,
    CalendarClientError,
    calendarIdempotencyKey,
    calendarToolName,
    cancelEvent,
    createEvent,
    eventFingerprint,
    freeBusy,
    parseMcpBody,
    updateEvent,
} from "../../../src/services/communication-calendar.client.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const okBody = (data) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(data) }] } });
const http = (impl) => ({ request: jest.fn(impl) });
const httpError = (status, data = "") => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

const eventInput = {
    tenantId: TENANT,
    interview: { id: 41 },
    attendees: [{ email: "panel@corp.test", name: "Sara Khan" }, { email: "" }],
    title: "Technical interview: Backend Engineer",
    description: "Interview type: Technical",
    start: new Date("2026-10-22T05:00:00Z"),
    end: new Date("2026-10-22T06:00:00Z"),
    location: "https://meet.example/abc",
    idempotencyKey: "hr-interview-41-CREATE-1",
};

const saved = { ...process.env };
afterEach(() => {
    process.env = { ...saved };
});
beforeEach(() => {
    delete process.env.COMMUNICATION_SERVICE_URL;
    delete process.env.COMMUNICATION_MCP_PATH;
    delete process.env.COMMUNICATION_CALENDAR_CREATE_TOOL;
});

describe("idempotency key and tool names", () => {
    it("is hr-interview-<id>-<ACTION>-<version>", () => {
        expect(calendarIdempotencyKey({ interviewId: 41, action: "create", version: 7 })).toBe("hr-interview-41-CREATE-7");
        expect(calendarIdempotencyKey({ interviewId: 41, action: "UPDATE", version: new Date("2026-10-20T00:00:00Z") })).toBe(
            `hr-interview-41-UPDATE-${Date.parse("2026-10-20T00:00:00Z")}`,
        );
        expect(calendarIdempotencyKey({ interviewId: 41, action: "CANCEL" })).toBe("hr-interview-41-CANCEL-0");
    });

    it("fingerprints are stable and content-sensitive", () => {
        expect(eventFingerprint({ a: 1 })).toBe(eventFingerprint({ a: 1 }));
        expect(eventFingerprint({ a: 1 })).not.toBe(eventFingerprint({ a: 2 }));
    });

    it("uses the documented tool names unless the env overrides one", () => {
        expect(calendarToolName("create", {})).toBe(CALENDAR_TOOL_DEFAULTS.create);
        expect(calendarToolName("create", { COMMUNICATION_CALENDAR_CREATE_TOOL: "comm_cal_create" })).toBe("comm_cal_create");
        expect(CALENDAR_TOOL_DEFAULTS).toEqual({
            create: "communication_calendar_event_create",
            update: "communication_calendar_event_update",
            cancel: "communication_calendar_event_cancel",
            freeBusy: "communication_calendar_free_busy",
        });
    });
});

describe("createEvent", () => {
    it("calls tools/call on the MCP endpoint with the event and the key", async () => {
        process.env.COMMUNICATION_SERVICE_URL = "http://comm.internal:4000/";
        process.env.COMMUNICATION_MCP_PATH = "mcp-rpc";
        const client = http(async () => ({ data: okBody({ provider: "GOOGLE_WORKSPACE", eventId: "evt-1" }) }));

        const ref = await createEvent(eventInput, { http: client });

        expect(ref).toEqual({ provider: "GOOGLE_WORKSPACE", eventId: "evt-1" });
        const call = client.request.mock.calls[0][0];
        expect(call.url).toBe("http://comm.internal:4000/mcp-rpc");
        expect(call.method).toBe("POST");
        expect(call.headers).toMatchObject({ "X-Tenant-Id": TENANT, "Idempotency-Key": "hr-interview-41-CREATE-1" });
        expect(call.data).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "communication_calendar_event_create" } });
        const args = call.data.params.arguments;
        expect(Object.keys(args).sort()).toEqual(
            ["attendees", "description", "end", "idempotencyKey", "location", "source", "sourceRef", "start", "tenantId", "title"].sort(),
        );
        expect(args.attendees).toEqual([{ email: "panel@corp.test", name: "Sara Khan", role: "required" }]);
        expect(args.start).toBe("2026-10-22T05:00:00.000Z");
        expect(args.sourceRef).toBe("hr-interview-41");
    });

    it("reads an SSE-framed reply", async () => {
        const sse = `event: message\ndata: ${okBody({ calendarProvider: "OUTLOOK_365", calendarEventId: "o-9" })}\n\n`;
        const ref = await createEvent(eventInput, { http: http(async () => ({ data: sse })) });
        expect(ref).toEqual({ provider: "OUTLOOK_365", eventId: "o-9" });
    });

    it.each([
        ["a 503", httpError(503), CALENDAR_ERROR.UNAVAILABLE, true],
        ["a 500", httpError(500), CALENDAR_ERROR.UNAVAILABLE, true],
        ["a 429", httpError(429), CALENDAR_ERROR.UNAVAILABLE, true],
        ["a 408", httpError(408), CALENDAR_ERROR.UNAVAILABLE, true],
        ["a 400", httpError(400), CALENDAR_ERROR.REJECTED, false],
        ["a 403", httpError(403), CALENDAR_ERROR.REJECTED, false],
        ["a 404", httpError(404), CALENDAR_ERROR.REJECTED, false],
        ["a timeout", Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" }), CALENDAR_ERROR.TIMEOUT, true],
        ["a refused connection", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), CALENDAR_ERROR.UNAVAILABLE, true],
    ])("classifies %s", async (_label, err, code, retryable) => {
        const promise = createEvent(eventInput, { http: http(async () => { throw err; }) });
        await expect(promise).rejects.toBeInstanceOf(CalendarClientError);
        await expect(createEvent(eventInput, { http: http(async () => { throw err; }) })).rejects.toMatchObject({ code, retryable });
    });

    it.each([
        ["method not found", { error: { code: -32601, message: "Method not found" } }, false],
        ["invalid params", { error: { code: -32602, message: "Unknown tool" } }, false],
        ["internal error", { error: { code: -32603, message: "boom" } }, true],
        ["tool error 500", { result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "x", status: 502 }) }] } }, true],
        ["tool error 422", { result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "x", status: 422 }) }] } }, false],
        ["tool error without status", { result: { isError: true, content: [] } }, false],
    ])("classifies a JSON-RPC %s", async (_label, body, retryable) => {
        const client = http(async () => ({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) }));
        await expect(createEvent(eventInput, { http: client })).rejects.toMatchObject({ retryable });
    });

    it("an answer without an event reference is a retryable bad response", async () => {
        const client = http(async () => ({ data: okBody({ ok: true }) }));
        await expect(createEvent(eventInput, { http: client })).rejects.toMatchObject({ code: CALENDAR_ERROR.BAD_RESPONSE, retryable: true });
        const junk = http(async () => ({ data: "<html>proxy</html>" }));
        await expect(createEvent(eventInput, { http: junk })).rejects.toMatchObject({ code: CALENDAR_ERROR.BAD_RESPONSE, retryable: true });
    });
});

describe("updateEvent and cancelEvent", () => {
    it("update sends the provider and event id and keeps them when the reply omits them", async () => {
        const client = http(async () => ({ data: okBody({ updated: true }) }));
        const ref = await updateEvent({ ...eventInput, provider: "GOOGLE_WORKSPACE", eventId: "evt-1" }, { http: client });
        expect(ref).toEqual({ provider: "GOOGLE_WORKSPACE", eventId: "evt-1" });
        const call = client.request.mock.calls[0][0];
        expect(call.data.params.name).toBe("communication_calendar_event_update");
        expect(call.data.params.arguments).toMatchObject({ provider: "GOOGLE_WORKSPACE", eventId: "evt-1" });
    });

    it("cancel calls the cancel tool and throws typed errors", async () => {
        const client = http(async () => ({ data: okBody({ cancelled: true }) }));
        await expect(cancelEvent({ provider: "P", eventId: "e", tenantId: TENANT, interview: { id: 41 } }, { http: client })).resolves.toMatchObject({ cancelled: true });
        expect(client.request.mock.calls[0][0].data.params.name).toBe("communication_calendar_event_cancel");
        await expect(cancelEvent({ provider: "P", eventId: "e", tenantId: TENANT }, { http: http(async () => { throw httpError(409); }) })).rejects.toMatchObject({ retryable: false });
    });
});

describe("freeBusy", () => {
    it("returns the busy map keyed by employee id", async () => {
        const client = http(async () => ({
            data: okBody({ busy: { 3: [{ start: "2026-10-22T05:00:00Z", end: "2026-10-22T06:00:00Z" }, { start: "bad", end: "x" }] } }),
        }));
        const res = await freeBusy({ tenantId: TENANT, employeeIds: [3, 4], emailsByEmployeeId: { 3: "a@corp.test" }, from: "2026-10-21T00:00:00Z", to: "2026-10-30T00:00:00Z" }, { http: client });
        expect(res).toEqual({
            available: true,
            busy: { 3: [{ start: "2026-10-22T05:00:00.000Z", end: "2026-10-22T06:00:00.000Z" }], 4: [] },
        });
        const args = client.request.mock.calls[0][0].data.params.arguments;
        expect(args.calendars).toEqual([{ employeeId: "3", email: "a@corp.test" }, { employeeId: "4", email: null }]);
    });

    it("is fail-soft: any failure is available:false", async () => {
        const res = await freeBusy({ tenantId: TENANT, employeeIds: [3] }, { http: http(async () => { throw httpError(500); }) });
        expect(res).toEqual({ available: false, busy: {} });
        const refused = await freeBusy({ tenantId: TENANT, employeeIds: [3] }, { http: http(async () => ({ data: JSON.stringify({ error: { code: -32601 } }) })) });
        expect(refused.available).toBe(false);
    });

    it("an empty panel needs no call", async () => {
        const client = http(async () => ({ data: okBody({}) }));
        await expect(freeBusy({ tenantId: TENANT, employeeIds: [] }, { http: client })).resolves.toEqual({ available: true, busy: {} });
        expect(client.request).not.toHaveBeenCalled();
    });
});

describe("parseMcpBody", () => {
    it("takes JSON, SSE and objects; null for junk", () => {
        expect(parseMcpBody('{"a":1}')).toEqual({ a: 1 });
        expect(parseMcpBody({ a: 1 })).toEqual({ a: 1 });
        expect(parseMcpBody("data: {\"a\":2}\n\n")).toEqual({ a: 2 });
        expect(parseMcpBody("")).toBeNull();
        expect(parseMcpBody("nope")).toBeNull();
    });
});

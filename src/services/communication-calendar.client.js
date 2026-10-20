// src/services/communication-calendar.client.js
//
// Recruitment Phase 3a — HR's ONLY client for calendars. HR never talks to
// Google or Microsoft: the Communication module (erp-communication) owns the
// provider connections and exposes MCP tools; this file calls them over
// JSON-RPC `tools/call` on that service's MCP endpoint.
//
//   createEvent / updateEvent / cancelEvent   communication_calendar_event_*
//   freeBusy                                  communication_calendar_free_busy
//
// Tool names, base URL, path and timeout are environment settings
// (COMMUNICATION_CALENDAR_*_TOOL, COMMUNICATION_SERVICE_URL,
// COMMUNICATION_MCP_PATH, COMMUNICATION_SERVICE_TIMEOUT), read at call time,
// because the Communication tools are still being built and their names may
// settle differently.
//
// Auth mirrors rbac.client.js / pmProjects.client.js: X-Internal-Secret, the
// EdDSA service JWT (carrying the tenant as `tid`) and the tenant header.
//
// Failure posture differs by call, on purpose:
//   * freeBusy is advisory: any failure answers { available: false } and the
//     slot finder falls back to leave and work schedules only.
//   * create / update / cancel THROW a CalendarClientError the sync worker
//     can act on: `retryable` for 5xx, 408/429, timeouts and network errors
//     (try again later); not retryable for any other 4xx or a tool refusal
//     (the request itself is wrong; retrying cannot help).
//
// Event content is built by the caller from a fixed list (interview type,
// requisition title, time, location or meeting link, panel names). This file
// adds nothing to it and logs none of it: log lines carry the interview id,
// the tool and the error class only.
import { createHash } from "node:crypto";

import axios from "axios";
import logger from "../lib/logger.js";
import { signServiceJwtEdDSA, ambientTenantHeader } from "../lib/serviceJwt.js";

const log = logger.child({ component: "communication-calendar-client" });

export const CALENDAR_TOOL_DEFAULTS = Object.freeze({
    create: "communication_calendar_event_create",
    update: "communication_calendar_event_update",
    cancel: "communication_calendar_event_cancel",
    freeBusy: "communication_calendar_free_busy",
});

const TOOL_ENV = Object.freeze({
    create: "COMMUNICATION_CALENDAR_CREATE_TOOL",
    update: "COMMUNICATION_CALENDAR_UPDATE_TOOL",
    cancel: "COMMUNICATION_CALENDAR_CANCEL_TOOL",
    freeBusy: "COMMUNICATION_CALENDAR_FREE_BUSY_TOOL",
});

export const CALENDAR_ERROR = Object.freeze({
    UNAVAILABLE: "HR-RECRUITMENT-CALENDAR-UNAVAILABLE",
    TIMEOUT: "HR-RECRUITMENT-CALENDAR-TIMEOUT",
    REJECTED: "HR-RECRUITMENT-CALENDAR-REJECTED",
    BAD_RESPONSE: "HR-RECRUITMENT-CALENDAR-BAD-RESPONSE",
});

export class CalendarClientError extends Error {
    constructor(message, { code, retryable, status = null } = {}) {
        super(message);
        this.name = "CalendarClientError";
        this.code = code;
        this.retryable = Boolean(retryable);
        this.status = status;
    }
}

const DEFAULT_BASE_URL = "http://localhost:3006";
const DEFAULT_PATH = "/mcp";
const DEFAULT_TIMEOUT_MS = 10_000;

/** The configured tool name for an operation (env override, else default). */
export function calendarToolName(op, env = process.env) {
    const configured = String(env[TOOL_ENV[op]] ?? "").trim();
    return configured || CALENDAR_TOOL_DEFAULTS[op];
}

function endpoint(env = process.env) {
    const base = String(env.COMMUNICATION_SERVICE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const rawPath = String(env.COMMUNICATION_MCP_PATH || DEFAULT_PATH).trim();
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const timeout = Number.parseInt(env.COMMUNICATION_SERVICE_TIMEOUT ?? "", 10);
    return { url: `${base}${path}`, timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS };
}

function authHeaders(tenantId) {
    const headers = {
        ...ambientTenantHeader(),
        ...(tenantId ? { "X-Tenant-Id": String(tenantId) } : {}),
        "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET,
        "Content-Type": "application/json",
        // The Streamable HTTP transport requires the SSE accept alongside JSON.
        Accept: "application/json, text/event-stream",
    };
    const token = signServiceJwtEdDSA(tenantId ? { tid: String(tenantId) } : {});
    if (token) headers["X-Service-Authorization"] = `Bearer ${token}`;
    return headers;
}

/**
 * The idempotency key of one calendar write, so a retried create replays
 * rather than duplicates: `hr-interview-${interviewId}-${action}-${version}`.
 * `version` is whatever identifies this revision of the interview (the sync
 * service passes a content fingerprint, see interview-calendar-sync).
 */
export function calendarIdempotencyKey({ interviewId, action, version }) {
    const v = version instanceof Date ? version.getTime() : version;
    return `hr-interview-${interviewId}-${String(action).toUpperCase()}-${v ?? "0"}`;
}

/** A short, stable fingerprint of the fields a calendar event is built from. */
export function eventFingerprint(fields) {
    return createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16);
}

// A Streamable HTTP reply is a JSON envelope or an SSE frame; take either.
export function parseMcpBody(body) {
    if (body && typeof body === "object") return body;
    if (typeof body !== "string") return null;
    const trimmed = body.trim();
    if (!trimmed) return null;
    if (/^event:|^data:/m.test(trimmed)) {
        const data = trimmed
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .filter(Boolean);
        const last = data[data.length - 1];
        if (!last) return null;
        try {
            return JSON.parse(last);
        } catch {
            return null;
        }
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

const isRetryableStatus = (status) => status >= 500 || status === 408 || status === 429;

/** Classify an axios failure into a CalendarClientError. */
export function classifyTransportError(err) {
    const status = Number(err?.response?.status) || null;
    if (status) {
        return new CalendarClientError(`Communication service answered ${status}`, {
            code: isRetryableStatus(status) ? CALENDAR_ERROR.UNAVAILABLE : CALENDAR_ERROR.REJECTED,
            retryable: isRetryableStatus(status),
            status,
        });
    }
    const timedOut = err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT" || /timeout/i.test(String(err?.message ?? ""));
    return new CalendarClientError(timedOut ? "Communication service timed out" : "Communication service unreachable", {
        code: timedOut ? CALENDAR_ERROR.TIMEOUT : CALENDAR_ERROR.UNAVAILABLE,
        retryable: true,
    });
}

// JSON-RPC error codes that mean "the server had a problem", not "the
// request was wrong" (-32603 internal error, -32000..-32099 server errors).
const isRetryableRpcCode = (code) => code === -32603 || (code <= -32000 && code >= -32099);

/** Classify a JSON-RPC reply; returns the tool's parsed result or throws. */
export function readToolResult(rpcMsg) {
    if (!rpcMsg || typeof rpcMsg !== "object") {
        throw new CalendarClientError("Unreadable reply from the Communication service", { code: CALENDAR_ERROR.BAD_RESPONSE, retryable: true });
    }
    if (rpcMsg.error) {
        const rpcCode = Number(rpcMsg.error.code);
        throw new CalendarClientError("Communication service refused the call", {
            code: isRetryableRpcCode(rpcCode) ? CALENDAR_ERROR.UNAVAILABLE : CALENDAR_ERROR.REJECTED,
            retryable: isRetryableRpcCode(rpcCode),
        });
    }
    const result = rpcMsg.result;
    const text = result?.content?.[0]?.text;
    let parsed = null;
    if (typeof text === "string" && text.trim()) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }
    }
    if (result?.isError) {
        // withToolError shape: { error, status, code }.
        const status = Number(parsed?.status) || null;
        const retryable = Boolean(status && isRetryableStatus(status));
        throw new CalendarClientError("Communication calendar tool refused the call", {
            code: retryable ? CALENDAR_ERROR.UNAVAILABLE : CALENDAR_ERROR.REJECTED,
            retryable,
            status,
        });
    }
    if (!parsed || typeof parsed !== "object") {
        throw new CalendarClientError("Unreadable reply from the Communication service", { code: CALENDAR_ERROR.BAD_RESPONSE, retryable: true });
    }
    return parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
}

let rpcSeq = 0;

/** One tools/call. Throws CalendarClientError. */
export async function callCalendarTool(op, args, { tenantId, idempotencyKey, http = axios, env = process.env } = {}) {
    const { url, timeout } = endpoint(env);
    const name = calendarToolName(op, env);
    rpcSeq = (rpcSeq + 1) % 1_000_000;
    const rpc = { jsonrpc: "2.0", id: idempotencyKey || `hr-calendar-${Date.now()}-${rpcSeq}`, method: "tools/call", params: { name, arguments: args } };
    let res;
    try {
        res = await http.request({
            url,
            method: "POST",
            timeout,
            headers: { ...authHeaders(tenantId), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
            data: rpc,
            responseType: "text",
            transitional: { silentJSONParsing: false },
        });
    } catch (err) {
        throw classifyTransportError(err);
    }
    return readToolResult(parseMcpBody(res?.data));
}

const iso = (value) => {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// The event body sent for create and update. Only these fields leave HR.
function eventArguments({ tenantId, interview, attendees, title, description, start, end, location, idempotencyKey }) {
    return {
        tenantId: tenantId ?? null,
        source: "hr.recruitment.interview",
        sourceRef: interview?.id != null ? `hr-interview-${interview.id}` : null,
        title: String(title ?? ""),
        description: String(description ?? ""),
        start: iso(start),
        end: iso(end),
        location: location ?? null,
        attendees: (attendees ?? [])
            .filter((a) => a?.email)
            .map((a) => ({ email: String(a.email), name: a.name ?? null, role: a.role ?? "required" })),
        idempotencyKey: idempotencyKey ?? null,
    };
}

function readEventRef(result, fallback = {}) {
    const provider = result?.provider ?? result?.calendarProvider ?? fallback.provider ?? null;
    const eventId = result?.eventId ?? result?.calendarEventId ?? result?.id ?? fallback.eventId ?? null;
    if (!provider || !eventId) {
        throw new CalendarClientError("The Communication service did not return the event reference", {
            code: CALENDAR_ERROR.BAD_RESPONSE,
            retryable: true,
        });
    }
    return { provider: String(provider), eventId: String(eventId) };
}

/**
 * Create the provider event. @returns {Promise<{ provider: string, eventId: string }>}
 * @throws {CalendarClientError}
 */
export async function createEvent(input = {}, options = {}) {
    try {
        const result = await callCalendarTool("create", eventArguments(input), {
            ...options,
            tenantId: input.tenantId,
            idempotencyKey: input.idempotencyKey,
        });
        return readEventRef(result);
    } catch (err) {
        log.warn({ interviewId: input.interview?.id ?? null, op: "create", code: err?.code, retryable: err?.retryable }, "calendar create failed");
        throw err;
    }
}

/** Update the provider event in place. @throws {CalendarClientError} */
export async function updateEvent({ provider, eventId, ...input } = {}, options = {}) {
    try {
        const result = await callCalendarTool(
            "update",
            { ...eventArguments(input), provider, eventId },
            { ...options, tenantId: input.tenantId, idempotencyKey: input.idempotencyKey },
        );
        return readEventRef(result, { provider, eventId });
    } catch (err) {
        log.warn({ interviewId: input.interview?.id ?? null, op: "update", code: err?.code, retryable: err?.retryable }, "calendar update failed");
        throw err;
    }
}

/** Cancel the provider event (attendees are told by the provider). @throws {CalendarClientError} */
export async function cancelEvent({ provider, eventId, tenantId, interview, idempotencyKey } = {}, options = {}) {
    try {
        await callCalendarTool(
            "cancel",
            { tenantId: tenantId ?? null, provider, eventId, sourceRef: interview?.id != null ? `hr-interview-${interview.id}` : null, idempotencyKey: idempotencyKey ?? null },
            { ...options, tenantId, idempotencyKey },
        );
        return { provider: String(provider), eventId: String(eventId), cancelled: true };
    } catch (err) {
        log.warn({ interviewId: interview?.id ?? null, op: "cancel", code: err?.code, retryable: err?.retryable }, "calendar cancel failed");
        throw err;
    }
}

function normalizeBusy(raw, employeeIds) {
    const busy = {};
    for (const id of employeeIds) busy[id] = [];
    const source = raw && typeof raw === "object" ? raw : {};
    for (const [key, list] of Object.entries(source)) {
        if (!Array.isArray(list)) continue;
        busy[key] = list
            .map((i) => ({ start: iso(i?.start), end: iso(i?.end) }))
            .filter((i) => i.start && i.end && i.end > i.start);
    }
    return busy;
}

/**
 * The panel's busy times. Never throws: an unreachable or refusing service is
 * { available: false, busy: {} }, and the caller plans without it.
 *
 * @returns {Promise<{ available: boolean, busy: Record<string, Array<{start: string, end: string}>> }>}
 */
export async function freeBusy({ tenantId, employeeIds = [], emailsByEmployeeId = {}, from, to } = {}, options = {}) {
    const ids = [...new Set((employeeIds ?? []).map((id) => String(id)))];
    if (!ids.length) return { available: true, busy: {} };
    // The Communication module looks mailboxes up by address; the employee id
    // is the key the answer comes back under.
    const calendars = ids.map((id) => ({ employeeId: id, email: emailsByEmployeeId?.[id] ?? null }));
    try {
        const result = await callCalendarTool(
            "freeBusy",
            { tenantId: tenantId ?? null, employeeIds: ids, calendars, from: iso(from), to: iso(to) },
            { ...options, tenantId },
        );
        return { available: true, busy: normalizeBusy(result?.busy, ids) };
    } catch (err) {
        log.warn({ op: "freeBusy", code: err?.code, retryable: err?.retryable, panelSize: ids.length }, "calendar free-busy unavailable");
        return { available: false, busy: {} };
    }
}

export default { createEvent, updateEvent, cancelEvent, freeBusy };

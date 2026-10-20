// tests/unit/middlewares/dependency-unavailable-errors.test.js
//
// Recruitment Phase 6 — a dependency that is unavailable (DAM, the AI plane,
// the calendar, the e-signature provider) used to reach clients as HR-5000
// "Internal server error", the same as a crash. It is now HR-5032 with a fixed
// safe message, the domain code in details.code and retryable: true, over REST
// and MCP alike. Every other 5xx stays HR-5000 with no detail (ERR-3).
import { describe, it, expect } from "@jest/globals";
import express from "express";
import request from "supertest";

import { normalizeError, errorHandler } from "../../../src/middlewares/error.middleware.js";
import { toJsonRpcError } from "../../../src/mcp/utils/mcpErrorMap.js";
import { withToolError } from "../../../src/mcp/utils/toolError.js";
import {
    DEPENDENCY_UNAVAILABLE_CODES,
    HR_ERRORS,
    HR_ERROR_BY_CODE,
    isDependencyUnavailableCode,
} from "../../../src/constants/errorCodes.js";

const SAFE = "A service this request depends on is temporarily unavailable; please try again";
const boom = (status, code, extra = {}) =>
    Object.assign(new Error(`internal detail: dam.internal:3002 said no for ${code}`), { status, code, ...extra });

const appThrowing = (err) => {
    const app = express();
    app.get("/x", () => {
        throw err;
    });
    app.use(errorHandler);
    return app;
};

describe("the HR-5032 registry entry", () => {
    it("is registered next to HR-5031 with a generic message", () => {
        expect(HR_ERRORS.DEPENDENCY_UNAVAILABLE).toEqual({ code: "HR-5032", httpStatus: 503, message: SAFE });
        expect(HR_ERROR_BY_CODE["HR-5032"]).toBe(HR_ERRORS.DEPENDENCY_UNAVAILABLE);
    });

    it("recognises the listed codes and any HR-*-UNAVAILABLE code", () => {
        for (const code of DEPENDENCY_UNAVAILABLE_CODES) expect(isDependencyUnavailableCode(code)).toBe(true);
        expect(isDependencyUnavailableCode("HR-RECRUITMENT-SOMETHING-NEW-UNAVAILABLE")).toBe(true);
        for (const code of ["HR-5000", "HR-RESUME-QUEUE", "HR-RECRUITMENT-SCORING-DISABLED", "unavailable", null, 503]) {
            expect(isDependencyUnavailableCode(code)).toBe(false);
        }
    });
});

describe("normalizeError", () => {
    it.each([
        [502, "HR-ONBOARDING-DAM-UNAVAILABLE"],
        [502, "HR-RECRUITMENT-OFFER-LETTER-DOCUMENT-UNAVAILABLE"],
        [502, "HR-RECRUITMENT-DSR-EXPORT-UPLOAD-FAILED"],
        [502, "HR-RECRUITMENT-ESIGN-PROVIDER-UNAVAILABLE"],
        [503, "HR-RECRUITMENT-AI-UNAVAILABLE"],
        [503, "HR-AI-PLANE-UNAVAILABLE"],
        [504, "HR-RESUME-PLANE-PENDING"],
    ])("maps %i %s to HR-5032 with the domain code in details", (status, code) => {
        const norm = normalizeError(boom(status, code, { details: { taskId: "secret-task" } }));
        expect(norm).toEqual({
            httpStatus: status,
            code: "HR-5032",
            message: SAFE,
            details: { code, retryable: true },
            isOperational: true,
        });
    });

    it("maps a calendar transport error (no status, or the upstream's) to HR-5032 as a 503", () => {
        const noStatus = Object.assign(new Error("Communication service unreachable"), {
            name: "CalendarClientError",
            code: "HR-RECRUITMENT-CALENDAR-UNAVAILABLE",
            status: null,
            retryable: true,
        });
        expect(normalizeError(noStatus)).toMatchObject({ httpStatus: 503, code: "HR-5032", details: { code: "HR-RECRUITMENT-CALENDAR-UNAVAILABLE" } });
        for (const status of [500, 429, 408]) {
            expect(normalizeError(boom(status, "HR-RECRUITMENT-CALENDAR-UNAVAILABLE"))).toMatchObject({ httpStatus: 503, code: "HR-5032" });
        }
        expect(normalizeError(boom(null, "HR-RECRUITMENT-CALENDAR-TIMEOUT"))).toMatchObject({ httpStatus: 503, code: "HR-5032" });
    });

    it("leaves a 4xx with an -UNAVAILABLE code alone (the slot that is no longer free)", () => {
        const slot = Object.assign(new Error("This time is no longer available, please pick another"), {
            status: 409,
            code: "HR-RECRUITMENT-SLOT-UNAVAILABLE",
        });
        expect(normalizeError(slot)).toMatchObject({ httpStatus: 409, code: "HR-4090", message: slot.message });
    });

    it("keeps every other 5xx HR-5000 with no detail, and the flag-off class HR-5031", () => {
        expect(normalizeError(boom(503, "HR-RESUME-QUEUE"))).toMatchObject({ httpStatus: 503, code: "HR-5000", details: undefined });
        expect(normalizeError(boom(500, "HR-RECRUITMENT-ESIGN-SEND-FAILED"))).toMatchObject({ code: "HR-5000", details: undefined });
        expect(normalizeError(new Error("boom"))).toMatchObject({ httpStatus: 500, code: "HR-5000" });
        expect(normalizeError(boom(503, "HR-RECRUITMENT-SCORING-DISABLED"))).toMatchObject({ code: "HR-5031" });
    });
});

describe("REST", () => {
    it("answers the envelope with HR-5032 and never the raw message or details", async () => {
        const res = await request(appThrowing(boom(502, "HR-ONBOARDING-DAM-UNAVAILABLE", { details: { bucket: "internal" } }))).get("/x");
        expect(res.status).toBe(502);
        expect(res.body.error).toMatchObject({
            code: "HR-5032",
            message: SAFE,
            details: { code: "HR-ONBOARDING-DAM-UNAVAILABLE", retryable: true },
        });
        expect(JSON.stringify(res.body)).not.toMatch(/internal detail|dam\.internal|bucket/);
    });

    it("still answers a real internal error as HR-5000 with no detail", async () => {
        const res = await request(appThrowing(boom(500, "HR-RECRUITMENT-SOMETHING-BROKE"))).get("/x");
        expect(res.status).toBe(500);
        expect(res.body.error).toEqual({ code: "HR-5000", message: "Internal server error" });
    });
});

describe("MCP", () => {
    it("maps to HR-5032 with the domain code in data.details", () => {
        const rpc = toJsonRpcError(boom(503, "HR-RECRUITMENT-AI-UNAVAILABLE"));
        expect(rpc).toEqual({
            code: -32603,
            message: SAFE,
            data: { code: "HR-5032", details: { code: "HR-RECRUITMENT-AI-UNAVAILABLE", retryable: true } },
        });
    });

    it("reaches a tool caller through withToolError without the raw text", async () => {
        const tool = withToolError(async () => {
            throw boom(502, "HR-RECRUITMENT-ESIGN-PROVIDER-UNAVAILABLE");
        }, "test_tool");
        const res = await tool({});
        expect(res.isError).toBe(true);
        const body = JSON.parse(res.content[0].text);
        expect(body).toMatchObject({
            error: SAFE,
            status: 502,
            code: "HR-5032",
            jsonrpc: { code: -32603, data: { code: "HR-5032", details: { code: "HR-RECRUITMENT-ESIGN-PROVIDER-UNAVAILABLE", retryable: true } } },
        });
        expect(res.content[0].text).not.toMatch(/internal detail/);
    });

    it("keeps a real internal error HR-5000 with no details", () => {
        const rpc = toJsonRpcError(boom(500, "HR-RECRUITMENT-SOMETHING-BROKE"));
        expect(rpc).toEqual({ code: -32603, message: "Internal server error", data: { code: "HR-5000" } });
    });
});

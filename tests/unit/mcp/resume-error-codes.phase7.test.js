// tests/unit/mcp/resume-error-codes.phase7.test.js
//
// Recruitment Phase 7 (D17) — what the resume-parsing path's failures reach an
// MCP client as. An unavailable AI plane, an unanswered plane task and an
// unreachable DAM are HR-5032 (retryable, the domain code in details.code);
// the AI flag off is HR-5031. None of them is the generic HR-5000.
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const TENANT = "11111111-1111-4111-8111-111111111111";

const prisma = {
    resumeParseAttempt: {
        findUnique: jest.fn(async () => null),
        upsert: jest.fn(async ({ create }) => ({ id: 5, ...create })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        delete: jest.fn(),
    },
    aiInferenceRecord: { create: jest.fn(async () => ({})) },
};
const downloadDamAssetBuffer = jest.fn();
const runAiTask = jest.fn();

jest.unstable_mockModule("../../../src/lib/prisma.js", () => ({ default: prisma }));
jest.unstable_mockModule("../../../src/lib/logger.js", () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule("../../../src/services/dam.media.service.js", () => ({ downloadDamAssetBuffer }));
jest.unstable_mockModule("../../../src/lib/aiPlaneClient.js", () => ({ runAiTask, collectAiResult: jest.fn() }));
jest.unstable_mockModule("../../../src/services/hrDomainEvent.service.js", () => ({ enqueueHrDomainEvent: jest.fn() }));

const resume = await import("../../../src/services/resumeParsing.service.js");
const { toJsonRpcError } = await import("../../../src/mcp/utils/mcpErrorMap.js");

const CV = "Payroll specialist, SAP HCM, statutory reporting, team lead for five years.";
const failureOf = async () => {
    try {
        await resume.parseResumeWithRetry(9, { tenantId: TENANT, candidateId: 3 });
    } catch (err) {
        return toJsonRpcError(err);
    }
    throw new Error("expected the parse to fail");
};

beforeEach(() => {
    jest.clearAllMocks();
    process.env.HR_RECRUITMENT_AI = "true";
    downloadDamAssetBuffer.mockResolvedValue({ buffer: Buffer.from(CV), mimeType: "text/plain", fileName: "cv.txt" });
});
afterEach(() => {
    delete process.env.HR_RECRUITMENT_AI;
});

describe("resume parsing failures carry numeric client codes", () => {
    it("AI plane down is HR-5032 with the domain code", async () => {
        runAiTask.mockRejectedValue(Object.assign(new Error("AI plane transport failed: ECONNREFUSED 10.0.0.1"), { status: 503, code: "HR-AI-PLANE-UNAVAILABLE" }));
        const rpc = await failureOf();
        expect(rpc.data).toEqual({ code: "HR-5032", details: { code: "HR-AI-PLANE-UNAVAILABLE", retryable: true } });
        expect(rpc.message).not.toMatch(/ECONNREFUSED/);
    });

    it("a plane task that did not answer in time is HR-5032", async () => {
        runAiTask.mockResolvedValue({ taskId: "t1", status: "pending", pending: true, sinceId: "1-0" });
        expect((await failureOf()).data).toMatchObject({ code: "HR-5032", details: { code: "HR-RESUME-PLANE-PENDING" } });
    });

    it("DAM unreachable is HR-5032", async () => {
        downloadDamAssetBuffer.mockResolvedValue(null);
        expect((await failureOf()).data).toMatchObject({ code: "HR-5032", details: { code: "HR-RESUME-DAM-FETCH" } });
    });

    it("the AI flag off is HR-5031", async () => {
        process.env.HR_RECRUITMENT_AI = "false";
        expect((await failureOf()).data.code).toBe("HR-5031");
    });
});

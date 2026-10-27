// tests/unit/services/interview-bulk-cancel.service.test.js
//
// Recruitment Phase 6 (stream C) — the bulk interview cancel and its tool:
// the coded reason is required and validated once before any write (OTHER
// needs notes, the system-only ASSESSMENT_NOT_PASSED is refused), the same
// code and notes reach every interview's cancelInterview, each id is isolated
// (an already cancelled one is reported, a failure does not stop the rest),
// and the tool is PUT on hr:recruitment with the caller as the actor.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const cancelInterview = jest.fn(async ({ interviewId, reasonCode }) => ({ interviewId, status: "CANCELLED", reasonCode }));
class ScheduleError extends Error {
    constructor(message, status, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}
jest.unstable_mockModule("../../../src/services/interview-schedule.service.js", () => ({ cancelInterview }));

const { cancelInterviewsBulk, BULK_CANCEL_REASONS } = await import("../../../src/services/interview-bulk-cancel.service.js");
const { registerInterviewBulkCancelTools } = await import("../../../src/mcp/tools/interview-bulk-cancel.tools.js");
const { mcpCtx } = await import("../../../src/mcp/context.js");

const TENANT = "11111111-1111-4111-8111-111111111111";
const bulk = (args) => cancelInterviewsBulk({ tenantId: TENANT, actorId: 7, reasonCode: "BUSINESS_REQUEST", interviewIds: [1, 2], ...args });

beforeEach(() => jest.clearAllMocks());

describe("cancelInterviewsBulk", () => {
    it("passes the same coded reason and notes to every interview's cancel", async () => {
        const out = await bulk({ interviewIds: [3, "4", 3], reasonCode: "OTHER", notes: "  Panel unavailable all week " });
        expect(cancelInterview).toHaveBeenCalledTimes(2);
        for (const [args] of cancelInterview.mock.calls) {
            expect(args).toEqual({ interviewId: expect.any(Number), reasonCode: "OTHER", notes: "Panel unavailable all week", tenantId: TENANT, actorId: 7 });
        }
        expect(cancelInterview.mock.calls.map(([a]) => a.interviewId)).toEqual([3, 4]);
        expect(out).toEqual({
            reasonCode: "OTHER", requested: 2, cancelled: 2, alreadyCancelled: 0, failed: 0,
            results: [{ interviewId: 3, status: "CANCELLED", reasonCode: "OTHER" }, { interviewId: 4, status: "CANCELLED", reasonCode: "OTHER" }],
        });
    });

    it("refuses a missing, unknown or system-only reason, and OTHER without notes, before any cancel", async () => {
        for (const reasonCode of [undefined, "", "WHATEVER", "ASSESSMENT_NOT_PASSED"]) {
            await expect(bulk({ reasonCode })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-SCHEDULE-REASON-INVALID" });
        }
        await expect(bulk({ reasonCode: "OTHER", notes: "  " })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-SCHEDULE-REASON-INVALID" });
        expect(cancelInterview).not.toHaveBeenCalled();
    });

    it("refuses an empty, malformed or oversized id list", async () => {
        for (const interviewIds of [[], null, [1, "x"], [0], Array.from({ length: 51 }, (_, i) => i + 1)]) {
            await expect(bulk({ interviewIds })).rejects.toMatchObject({ status: 400, code: "HR-RECRUITMENT-INTERVIEW-BULK-INVALID" });
        }
        expect(cancelInterview).not.toHaveBeenCalled();
    });

    it("isolates each interview: already cancelled is reported, a failure does not stop the rest", async () => {
        cancelInterview
            .mockRejectedValueOnce(new ScheduleError("Interview is already cancelled", 409, "HR-RECRUITMENT-SCHEDULE-ALREADY-CANCELLED"))
            .mockRejectedValueOnce(new ScheduleError("Interview not found", 404, "HR-RECRUITMENT-SCHEDULE-NOT-FOUND"))
            .mockRejectedValueOnce(Object.assign(new Error("connection reset"), { status: 500 }));
        const out = await bulk({ interviewIds: [1, 2, 3, 4] });
        expect(out).toMatchObject({ requested: 4, cancelled: 1, alreadyCancelled: 1, failed: 2 });
        expect(out.results).toEqual([
            { interviewId: 1, status: "ALREADY_CANCELLED" },
            { interviewId: 2, status: "FAILED", error: { status: 404, code: "HR-RECRUITMENT-SCHEDULE-NOT-FOUND", message: "Interview not found" } },
            { interviewId: 3, status: "FAILED", error: { status: 500, code: null, message: "The interview could not be cancelled" } },
            { interviewId: 4, status: "CANCELLED", reasonCode: "BUSINESS_REQUEST" },
        ]);
    });

    it("offers exactly the single cancel's reasons", () => {
        expect(BULK_CANCEL_REASONS).toEqual(["CANDIDATE_REQUEST", "INTERVIEWER_CONFLICT", "BUSINESS_REQUEST", "TECHNICAL_ISSUE", "LOGISTICS_ISSUE", "REQUISITION_CLOSED", "OTHER"]);
    });
});

describe("hr_interviews_cancel_bulk", () => {
    const handlers = new Map();
    registerInterviewBulkCancelTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });
    const user = { tenantId: TENANT, employeeId: 7, roles: ["RECRUITER"], isAdmin: false };
    const call = (args, permissions = { "hr:recruitment": ["VIEW", "EDIT"] }) =>
        mcpCtx.run({ user, permissions }, async () => await handlers.get("hr_interviews_cancel_bulk")(args));

    it("cancels with the caller as the actor", async () => {
        const res = await call({ interviewIds: [5, 6], reasonCode: "REQUISITION_CLOSED" });
        expect(JSON.parse(res.content[0].text)).toMatchObject({ requested: 2, cancelled: 2 });
        expect(cancelInterview).toHaveBeenCalledWith(expect.objectContaining({ interviewId: 5, reasonCode: "REQUISITION_CLOSED", tenantId: TENANT, actorId: 7, notes: null }));
    });

    it("needs PUT on hr:recruitment", async () => {
        const res = await call({ interviewIds: [5], reasonCode: "REQUISITION_CLOSED" }, { "hr:recruitment": ["VIEW"] });
        expect(res.isError).toBe(true);
        expect(cancelInterview).not.toHaveBeenCalled();
    });
});

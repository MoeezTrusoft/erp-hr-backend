// Phase 7 (D17) proposed test: the REST resume controller answers an AI-plane
// outage with HR-5032 (domain code in details.code), the AI flag off with
// HR-5031, and keeps HR-5000 for an unexpected failure.
import { jest, describe, it, expect } from "@jest/globals";

const parseResumePreview = jest.fn();
jest.unstable_mockModule("../../../src/services/resumeParsing.service.js", () => ({
    parseResumePreview, ingestEmployeeResume: jest.fn(), ingestCandidateResume: jest.fn(),
}));
const { previewResume } = await import("../../../src/controllers/resume.controller.js");

const run = async (err) => {
    parseResumePreview.mockRejectedValueOnce(err);
    const res = { status: jest.fn(() => res), json: jest.fn(() => res), req: { requestId: "r1" } };
    await previewResume({ user: { tenantId: "t", permissions: { "hr:employee": ["VIEW"] } }, body: { resumeMediaId: 9 }, query: {}, params: {} }, res);
    return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
};

describe("resume controller error codes", () => {
    it("AI plane down -> 503 HR-5032", async () => {
        const out = await run(Object.assign(new Error("AI plane transport failed: ECONNREFUSED"), { status: 503, code: "HR-AI-PLANE-UNAVAILABLE" }));
        expect(out.status).toBe(503);
        expect(out.body.errors[0]).toMatchObject({ code: "HR-5032", details: { code: "HR-AI-PLANE-UNAVAILABLE", retryable: true } });
        expect(JSON.stringify(out.body)).not.toContain("ECONNREFUSED");
    });
    it("plane failure -> 502 HR-5032", async () => {
        const out = await run(Object.assign(new Error("AI plane parse failed: provider down"), { status: 502, code: "HR-RESUME-PLANE-FAILED" }));
        expect(out).toMatchObject({ status: 502, body: { errors: [{ code: "HR-5032", details: { code: "HR-RESUME-PLANE-FAILED" } }] } });
    });
    it("flag off -> 503 HR-5031", async () => {
        const out = await run(Object.assign(new Error("off"), { status: 503, code: "HR-RECRUITMENT-AI-DISABLED" }));
        expect(out.body.errors[0].code).toBe("HR-5031");
    });
    it("unexpected -> 500 HR-5000", async () => {
        const out = await run(new Error("boom"));
        expect(out).toMatchObject({ status: 500, body: { errors: [{ code: "HR-5000" }] } });
    });
});

// Recruitment Phase 7 (A6) — POST /public/candidates/resume and the resume on
// the portal's writes. Pinned: the tenant comes from the host (never the
// body); the answer is the service's opaque reference; a refused file or draft
// token is a 400 with its code; an outage is a 503 "try again"; a host with no
// tenant and the portal being off are the uniform 404; the route has its own
// budget; the direct apply passes only a verified reference on as the trusted
// resume, and the draft save's refusal carries its code.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const uploadPortalResume = jest.fn();
const resumeMediaIdForApply = jest.fn(() => null);
const submitPublicApplication = jest.fn(async () => ({ received: true, requisitionId: 5 }));
const saveApplicationDraft = jest.fn(async () => ({ saved: true }));

jest.unstable_mockModule("../../../src/services/portal-resume-upload.service.js", () => ({
    PORTAL_RESUME_CODES: { UNAVAILABLE: "HR-RECRUITMENT-PORTAL-RESUME-UNAVAILABLE" },
    uploadPortalResume,
    resumeMediaIdForApply,
}));
jest.unstable_mockModule("../../../src/services/public-portal.service.js", () => ({
    listPublicJobs: jest.fn(),
    getPublicJob: jest.fn(),
    submitPublicApplication,
}));
jest.unstable_mockModule("../../../src/services/interview-slot-offer.service.js", () => ({
    getSlotOfferForCandidate: jest.fn(),
    confirmSlotOffer: jest.fn(),
    declineSlotOffer: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/candidate-verification.service.js", () => ({ consumeEmailVerification: jest.fn() }));
jest.unstable_mockModule("../../../src/services/candidate-status.service.js", () => ({ requestStatusLink: jest.fn(), readStatusViaLink: jest.fn() }));
jest.unstable_mockModule("../../../src/services/application-draft.service.js", () => ({
    saveApplicationDraft,
    loadApplicationDraft: jest.fn(),
    submitApplicationDraft: jest.fn(),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
process.env.HR_PORTAL_HOSTS = `careers.test=${TENANT}`;

const { default: portalRouter } = await import("../../../src/routes/public-portal.routes.js");
const { resetRateLimitMemory } = await import("../../../src/lib/rate-limit.util.js");

const app = express();
app.set("trust proxy", false);
app.use("/public", portalRouter);

const FILE = { fileName: "cv.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0xLjcK" };
const upload = (body, host = "careers.test") => request(app).post("/public/candidates/resume").set("Host", host).send(body);
const coded = (message, status, code, details = {}) => Object.assign(new Error(message), { status, code, details: { code, ...details } });

beforeEach(() => {
    jest.clearAllMocks();
    resetRateLimitMemory();
});

describe("POST /public/candidates/resume", () => {
    it("stores under the pinned tenant and answers the reference (a body tenant is ignored)", async () => {
        const data = { resumeRef: "pr1.abc", fileName: "cv.pdf", size: 9, expiresAt: "2026-10-28T09:00:00.000Z", boundToDraft: true };
        uploadPortalResume.mockResolvedValueOnce(data);
        const res = await upload({ ...FILE, draftToken: "tok", tenantId: "forged" });
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ success: true, data });
        expect(uploadPortalResume).toHaveBeenCalledWith({ tenantId: TENANT, resume: FILE, draftToken: "tok" });
    });

    it("a refused file or draft link is a 400 with its code", async () => {
        uploadPortalResume.mockRejectedValueOnce(coded("The resume must be a PDF file", 400, "HR-RECRUITMENT-PORTAL-RESUME-INVALID", { reason: "TYPE" }));
        const bad = await upload(FILE);
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({
            success: false,
            message: "The resume must be a PDF file",
            details: { code: "HR-RECRUITMENT-PORTAL-RESUME-INVALID", reason: "TYPE" },
        });
        uploadPortalResume.mockRejectedValueOnce(coded("This draft link is not valid", 400, "HR-RECRUITMENT-PORTAL-RESUME-DRAFT-INVALID"));
        const draft = await upload({ ...FILE, draftToken: "dead" });
        expect(draft.body.details).toEqual({ code: "HR-RECRUITMENT-PORTAL-RESUME-DRAFT-INVALID" });
    });

    it("an outage (DAM down, no key) is a 503 to try again with no internals", async () => {
        uploadPortalResume.mockRejectedValueOnce(coded("dam said no at http://dam.internal", 503, "HR-RECRUITMENT-PORTAL-RESUME-UNAVAILABLE"));
        uploadPortalResume.mockRejectedValueOnce(new Error("boom"));
        for (const res of [await upload(FILE), await upload(FILE)]) {
            expect(res.status).toBe(503);
            expect(res.body).toEqual({
                success: false,
                message: "We could not store your resume right now. Please try again in a few minutes.",
                details: { code: "HR-RECRUITMENT-PORTAL-RESUME-UNAVAILABLE" },
            });
        }
    });

    it("an unknown host and the portal being off are the uniform 404", async () => {
        const unknown = await upload(FILE, "unknown.test");
        expect(unknown.status).toBe(404);
        expect(uploadPortalResume).not.toHaveBeenCalled();
        uploadPortalResume.mockRejectedValueOnce(Object.assign(new Error("Not found"), { status: 404, code: "HR-PORTAL-NOT-FOUND" }));
        const off = await upload(FILE);
        expect(off.status).toBe(404);
        expect(off.body).toEqual({ success: false, message: "Not found" });
    });

    it("has its own budget: six a minute per IP, then 429, and the apply budget is untouched", async () => {
        uploadPortalResume.mockResolvedValue({ resumeRef: "pr1.x" });
        const statuses = [];
        for (let i = 0; i < 7; i += 1) statuses.push((await upload(FILE)).status);
        expect(statuses.slice(0, 6).every((s) => s === 201)).toBe(true);
        expect(statuses[6]).toBe(429);
        const apply = await request(app).post("/public/jobs/5/apply").set("Host", "careers.test").send({ email: "a@example.com" });
        expect(apply.status).toBe(201);
    });
});

describe("the resume on the portal's writes", () => {
    it("the direct apply passes the verified reference's media id on as the trusted resume", async () => {
        resumeMediaIdForApply.mockReturnValueOnce(4242);
        const res = await request(app).post("/public/jobs/5/apply").set("Host", "careers.test").send({ email: "a@example.com", resumeRef: "pr1.ok" });
        expect(res.status).toBe(201);
        expect(resumeMediaIdForApply).toHaveBeenCalledWith({ tenantId: TENANT, body: expect.objectContaining({ resumeRef: "pr1.ok" }) });
        expect(submitPublicApplication).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, resumeMediaId: 4242 }));
    });

    it("the direct apply refuses a bad reference with its code before the intake runs", async () => {
        resumeMediaIdForApply.mockImplementationOnce(() => {
            throw coded("Upload the resume file; a media id cannot be attached", 400, "HR-RECRUITMENT-PORTAL-RESUME-UNVERIFIED");
        });
        const res = await request(app).post("/public/jobs/5/apply").set("Host", "careers.test").send({ email: "a@example.com", resumeMediaId: 9 });
        expect(res.status).toBe(400);
        expect(res.body.details).toEqual({ code: "HR-RECRUITMENT-PORTAL-RESUME-UNVERIFIED" });
        expect(submitPublicApplication).not.toHaveBeenCalled();
    });

    it("a refused draft resume carries its code; the uniform saved body otherwise", async () => {
        saveApplicationDraft.mockRejectedValueOnce(coded("The resume reference is not valid; upload the resume again", 400, "HR-RECRUITMENT-PORTAL-RESUME-REF-INVALID"));
        const res = await request(app).post("/public/candidates/draft").set("Host", "careers.test").send({ email: "a@example.com", requisitionId: 5, resumeRef: "x" });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            success: false,
            message: "The resume reference is not valid; upload the resume again",
            details: { code: "HR-RECRUITMENT-PORTAL-RESUME-REF-INVALID" },
        });
        const ok = await request(app).post("/public/candidates/draft").set("Host", "careers.test").send({ email: "a@example.com", requisitionId: 5 });
        expect(ok.body).toEqual({ success: true, data: { saved: true } });
    });
});

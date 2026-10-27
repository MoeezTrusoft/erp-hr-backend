// Recruitment Phase 6 — POST /public/candidates/interview-slots/decline:
// pinned tenant, one 200 for a live link, the same 404 body as the other slot
// routes for every dead link or refusal, a 400 for a malformed reason, and its
// own rate-limit budget.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const declineSlotOffer = jest.fn();

jest.unstable_mockModule("../../../src/services/interview-slot-offer.service.js", () => ({
    getSlotOfferForCandidate: jest.fn(),
    confirmSlotOffer: jest.fn(),
    declineSlotOffer,
}));
jest.unstable_mockModule("../../../src/services/public-portal.service.js", () => ({
    listPublicJobs: jest.fn(),
    getPublicJob: jest.fn(),
    submitPublicApplication: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/candidate-verification.service.js", () => ({ consumeEmailVerification: jest.fn() }));
jest.unstable_mockModule("../../../src/services/candidate-status.service.js", () => ({ requestStatusLink: jest.fn(), readStatusViaLink: jest.fn() }));
jest.unstable_mockModule("../../../src/services/application-draft.service.js", () => ({
    saveApplicationDraft: jest.fn(),
    loadApplicationDraft: jest.fn(),
    submitApplicationDraft: jest.fn(),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
process.env.HR_PORTAL_HOSTS = `careers.test=${TENANT}`;

const { interviewSlotsRouter } = await import("../../../src/routes/public-portal.routes.js");
const { resetRateLimitMemory } = await import("../../../src/lib/rate-limit.util.js");

const app = express();
app.set("trust proxy", false);
app.use("/public", interviewSlotsRouter);

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
const NOT_FOUND = { success: false, message: "This interview link is not valid" };
const post = (body) => request(app).post("/public/candidates/interview-slots/decline").set("Host", "careers.test").send(body);

beforeEach(() => jest.clearAllMocks());

describe("POST /public/candidates/interview-slots/decline", () => {
    it("declines with the pinned tenant (a body tenant is ignored)", async () => {
        declineSlotOffer.mockResolvedValue({ declined: true });
        const res = await post({ token: TOKEN, reason: "NONE_SUIT", tenantId: "forged" });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, data: { declined: true } });
        expect(declineSlotOffer).toHaveBeenCalledWith({ token: TOKEN, reason: "NONE_SUIT", tenantId: TENANT });
    });

    it("an outage asks the candidate to try again (503), never a dead link", async () => {
        declineSlotOffer.mockRejectedValueOnce(new Error("db down"));
        const res = await post({ token: TOKEN });
        expect(res.status).toBe(503);
        expect(res.body).toEqual({
            success: false,
            message: "We could not record your answer right now. Please try again in a few minutes.",
        });
    });

    it("a dead link and any refusal are the slot routes' one 404 body; a bad reason is a 400", async () => {
        declineSlotOffer.mockResolvedValueOnce(null);
        const dead = await post({ token: TOKEN });
        declineSlotOffer.mockRejectedValueOnce(Object.assign(new Error("not offered"), { status: 409 }));
        const refused = await post({ token: TOKEN });
        for (const res of [dead, refused]) {
            expect(res.status).toBe(404);
            expect(res.body).toEqual(NOT_FOUND);
        }
        declineSlotOffer.mockRejectedValueOnce(Object.assign(new Error("reason must be one of NONE_SUIT, OTHER"), { status: 400, code: "HR-RECRUITMENT-SLOT-DECLINE-REASON-INVALID" }));
        const bad = await post({ token: TOKEN, reason: "because" });
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ success: false, message: "reason must be one of NONE_SUIT, OTHER" });
    });

    it("a host with no tenant is not a site", async () => {
        const res = await request(app).post("/public/candidates/interview-slots/decline").set("Host", "unknown.test").send({ token: TOKEN });
        expect(res.status).toBe(404);
        expect(declineSlotOffer).not.toHaveBeenCalled();
    });

    it("has its own budget: ten a minute per IP, then 429", async () => {
        declineSlotOffer.mockResolvedValue(null);
        // Start from an empty window so the count does not depend on the tests above.
        resetRateLimitMemory();
        const statuses = [];
        for (let i = 0; i < 11; i += 1) statuses.push((await post({ token: TOKEN })).status);
        expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
        expect(statuses[10]).toBe(429);
    });
});

// Recruitment Phase 3a — the public interview slot routes: tenant pinning,
// the portal context, and uniform answers (one 404 body for every not-found
// reason, one 409 body for every "slot gone" reason).
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const getSlotOfferForCandidate = jest.fn();
const confirmSlotOffer = jest.fn();

jest.unstable_mockModule("../../../src/services/interview-slot-offer.service.js", () => ({ getSlotOfferForCandidate, confirmSlotOffer }));
jest.unstable_mockModule("../../../src/services/publicPortal.service.js", () => ({
    listPublicJobs: jest.fn(),
    getPublicJob: jest.fn(),
    submitPublicApplication: jest.fn(),
}));
jest.unstable_mockModule("../../../src/services/candidateVerification.service.js", () => ({ consumeEmailVerification: jest.fn() }));
jest.unstable_mockModule("../../../src/services/candidateStatus.service.js", () => ({ requestStatusLink: jest.fn(), readStatusViaLink: jest.fn() }));
jest.unstable_mockModule("../../../src/services/applicationDraft.service.js", () => ({
    saveApplicationDraft: jest.fn(),
    loadApplicationDraft: jest.fn(),
    submitApplicationDraft: jest.fn(),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
process.env.HR_PORTAL_HOSTS = `careers.test=${TENANT}`;

const { default: router, interviewSlotsRouter } = await import("../../../src/routes/publicPortal.routes.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const app = express();
app.set("trust proxy", false);
app.use("/public", router);
app.use("/public", interviewSlotsRouter);

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
const NOT_FOUND = { success: false, message: "This interview link is not valid" };
const TAKEN = { success: false, message: "This time is no longer available, please pick another" };
const onPortal = (req) => req.set("Host", "careers.test");

beforeEach(() => {
    jest.clearAllMocks();
});

describe("GET /public/candidates/interview-slots", () => {
    it("returns the view, with the pinned tenant and the portal context", async () => {
        let seen = null;
        getSlotOfferForCandidate.mockImplementation(async () => {
            seen = mcpCtx.getStore();
            return { slots: [{ start: "2026-10-20T04:00:00.000Z", end: "2026-10-20T05:00:00.000Z" }] };
        });
        const res = await onPortal(request(app).get(`/public/candidates/interview-slots?token=${TOKEN}`));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, data: { slots: [{ start: "2026-10-20T04:00:00.000Z", end: "2026-10-20T05:00:00.000Z" }] } });
        expect(getSlotOfferForCandidate).toHaveBeenCalledWith({ token: TOKEN, tenantId: TENANT });
        expect(seen).toMatchObject({ user: { tenantId: TENANT }, portal: true });
    });

    it("answers one 404 body for unknown links and service failures", async () => {
        getSlotOfferForCandidate.mockResolvedValueOnce(null);
        const unknown = await onPortal(request(app).get(`/public/candidates/interview-slots?token=${TOKEN}`));
        getSlotOfferForCandidate.mockRejectedValueOnce(new Error("db down"));
        const broken = await onPortal(request(app).get(`/public/candidates/interview-slots?token=${TOKEN}`));
        for (const res of [unknown, broken]) {
            expect(res.status).toBe(404);
            expect(res.body).toEqual(NOT_FOUND);
        }
    });

    it("a host with no tenant is not a site", async () => {
        const res = await request(app).get(`/public/candidates/interview-slots?token=${TOKEN}`).set("Host", "unknown.test");
        expect(res.status).toBe(404);
        expect(getSlotOfferForCandidate).not.toHaveBeenCalled();
    });
});

describe("POST /public/candidates/interview-slots/confirm", () => {
    const post = (body) => onPortal(request(app).post("/public/candidates/interview-slots/confirm")).send(body);

    it("confirms with the pinned tenant", async () => {
        confirmSlotOffer.mockResolvedValue({ confirmed: true, start: "2026-10-20T04:00:00.000Z" });
        const res = await post({ token: TOKEN, slotStart: "2026-10-20T04:00:00.000Z", tenantId: "forged" });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ confirmed: true });
        expect(confirmSlotOffer).toHaveBeenCalledWith({ token: TOKEN, slotStart: "2026-10-20T04:00:00.000Z", tenantId: TENANT });
    });

    it("a slot that is gone is one 409 body; anything else is the 404 body", async () => {
        confirmSlotOffer.mockRejectedValueOnce(Object.assign(new Error("internal detail about leave"), { status: 409, code: "HR-RECRUITMENT-SLOT-UNAVAILABLE" }));
        const taken = await post({ token: TOKEN, slotStart: "2026-10-20T04:00:00.000Z" });
        expect(taken.status).toBe(409);
        expect(taken.body).toEqual(TAKEN);

        confirmSlotOffer.mockResolvedValueOnce(null);
        const unknown = await post({ token: TOKEN, slotStart: "2026-10-20T04:00:00.000Z" });
        confirmSlotOffer.mockRejectedValueOnce(Object.assign(new Error("on the do-not-contact register"), { status: 409, code: "HR-RECRUITMENT-DNC-BLOCKED" }));
        const blocked = await post({ token: TOKEN, slotStart: "2026-10-20T04:00:00.000Z" });
        for (const res of [unknown, blocked]) {
            expect(res.status).toBe(404);
            expect(res.body).toEqual(NOT_FOUND);
        }
    });

    it("has its own rate-limit budget, separate from the application budget", async () => {
        confirmSlotOffer.mockResolvedValue(null);
        // Ten confirms a minute per IP (four were spent above), then 429.
        const statuses = [];
        for (let i = 0; i < 7; i += 1) statuses.push((await post({ token: TOKEN, slotStart: "x" })).status);
        expect(statuses.slice(0, 6)).toEqual([404, 404, 404, 404, 404, 404]);
        expect(statuses[6]).toBe(429);
        // The application endpoints still have their whole budget.
        const apply = await onPortal(request(app).post("/public/candidates/status-link")).send({ email: "a@example.com" });
        expect(apply.status).not.toBe(429);
    });

    it("leaves the portal router's own route list untouched", () => {
        const paths = (r) => r.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort();
        expect(paths(interviewSlotsRouter)).toEqual(["GET /candidates/interview-slots", "POST /candidates/interview-slots/confirm"]);
        expect(paths(router).some((p) => p.includes("interview-slots"))).toBe(false);
    });
});

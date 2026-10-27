// Recruitment Phase 6 — the public invitation answer routes: tenant pinning,
// the portal context, fixed bodies (one 404 for every dead link, a 409 for a
// closed role, 503 with the flag off, a generic 500), no-store headers, and
// their own rate-limit budgets.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const getInvitationForCandidate = jest.fn();
const respondViaInvitationLink = jest.fn();

jest.unstable_mockModule("../../../src/services/invitation-response.service.js", () => ({ getInvitationForCandidate, respondViaInvitationLink }));
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
jest.unstable_mockModule("../../../src/services/interview-slot-offer.service.js", () => ({
    getSlotOfferForCandidate: jest.fn(),
    confirmSlotOffer: jest.fn(),
    declineSlotOffer: jest.fn(),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
process.env.HR_PORTAL_HOSTS = `careers.test=${TENANT}`;

const { invitationResponseRouter, resetInvitationResponseRateLimits } = await import("../../../src/routes/invitation-response.routes.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const app = express();
app.set("trust proxy", false);
app.use("/public", invitationResponseRouter);

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
const NOT_VALID = { success: false, message: "This invitation link is not valid" };
const onPortal = (req) => req.set("Host", "careers.test");
const get = (token = TOKEN) => onPortal(request(app).get(`/public/invitations/respond?token=${token}`));
const post = (body) => onPortal(request(app).post("/public/invitations/respond")).send(body);
const coded = (status, code, message = "internal detail") => Object.assign(new Error(message), { status, code });

beforeEach(() => {
    jest.clearAllMocks();
    resetInvitationResponseRateLimits();
});

describe("GET /public/invitations/respond", () => {
    it("returns the role title under the pinned tenant and the portal context, never cached", async () => {
        let seen = null;
        getInvitationForCandidate.mockImplementation(async () => {
            seen = mcpCtx.getStore();
            return { jobTitle: "Backend Engineer", expiresAt: "2026-11-03T09:00:00.000Z" };
        });
        const res = await get();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, data: { jobTitle: "Backend Engineer", expiresAt: "2026-11-03T09:00:00.000Z" } });
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.headers["referrer-policy"]).toBe("no-referrer");
        expect(getInvitationForCandidate).toHaveBeenCalledWith({ tenantId: TENANT, token: TOKEN });
        expect(seen).toMatchObject({ user: { tenantId: TENANT }, portal: true });
    });

    it("every dead link and every refusal is one 404 body; an outage is a generic 500", async () => {
        getInvitationForCandidate.mockResolvedValueOnce(null);
        const dead = await get();
        getInvitationForCandidate.mockRejectedValueOnce(coded(404, "HR-RECRUITMENT-INVITATION-LINK-INVALID"));
        const refused = await get();
        for (const res of [dead, refused]) {
            expect(res.status).toBe(404);
            expect(res.body).toEqual(NOT_VALID);
        }
        getInvitationForCandidate.mockRejectedValueOnce(new Error("db down"));
        const broken = await get();
        expect(broken.status).toBe(500);
        expect(broken.body).toEqual({ success: false, message: "Something went wrong" });
    });

    it("flag off is a 503 without detail; a host with no tenant is not a site", async () => {
        getInvitationForCandidate.mockRejectedValueOnce(coded(503, "HR-RECRUITMENT-INVITATION-LINKS-DISABLED"));
        const off = await get();
        expect(off.status).toBe(503);
        expect(off.body).toEqual({ success: false, message: "Invitation responses are not available" });
        const nowhere = await request(app).get(`/public/invitations/respond?token=${TOKEN}`).set("Host", "unknown.test");
        expect(nowhere.status).toBe(404);
        expect(getInvitationForCandidate).toHaveBeenCalledTimes(1);
    });
});

describe("POST /public/invitations/respond", () => {
    it("records the answer with the pinned tenant (a body tenant is ignored)", async () => {
        respondViaInvitationLink.mockResolvedValue({ answer: "ACCEPTED", applicationReceived: true });
        const res = await post({ token: TOKEN, answer: "ACCEPT", note: "Keen", tenantId: "forged" });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, data: { answer: "ACCEPTED", applicationReceived: true } });
        expect(respondViaInvitationLink).toHaveBeenCalledWith({ tenantId: TENANT, token: TOKEN, body: { answer: "ACCEPT", note: "Keen" } });
    });

    it("maps a dead link to the 404 body, a closed role to 409 and a bad body to 400", async () => {
        respondViaInvitationLink.mockResolvedValueOnce(null);
        const dead = await post({ token: TOKEN, answer: "ACCEPT" });
        expect(dead.status).toBe(404);
        expect(dead.body).toEqual(NOT_VALID);

        respondViaInvitationLink.mockRejectedValueOnce(coded(409, "HR-RECRUITMENT-INVITATION-ROLE-CLOSED"));
        const closed = await post({ token: TOKEN, answer: "ACCEPT" });
        expect(closed.status).toBe(409);
        expect(closed.body).toEqual({ success: false, message: "This role is no longer open for applications" });

        respondViaInvitationLink.mockRejectedValueOnce(coded(400, "HR-RECRUITMENT-INVITATION-RESPONSE-INVALID", "answer must be ACCEPT or DECLINE"));
        const bad = await post({ token: TOKEN, answer: "MAYBE" });
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ success: false, message: "answer must be ACCEPT or DECLINE" });

        // Any other 4xx (a refusal the service did not translate) is the dead-link body.
        respondViaInvitationLink.mockRejectedValueOnce(coded(409, "HR-RECRUITMENT-DNC-BLOCKED", "on the do-not-contact register"));
        const blocked = await post({ token: TOKEN, answer: "ACCEPT" });
        expect(blocked.status).toBe(404);
        expect(blocked.body).toEqual(NOT_VALID);
    });

    it("has its own budget: ten answers a minute per IP, then 429", async () => {
        respondViaInvitationLink.mockResolvedValue(null);
        const statuses = [];
        for (let i = 0; i < 11; i += 1) statuses.push((await post({ token: TOKEN, answer: "DECLINE" })).status);
        expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
        expect(statuses[10]).toBe(429);
        // Reading is a separate class.
        getInvitationForCandidate.mockResolvedValue(null);
        expect((await get()).status).toBe(404);
    });

    it("exposes exactly the two routes", () => {
        const paths = invitationResponseRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort();
        expect(paths).toEqual(["GET /invitations/respond", "POST /invitations/respond"]);
    });
});

// Recruitment Phase 5 (plan 6.9) — the public data-subject request routes:
// tenant pinning, the portal context, the rate limit, and answers that never
// tell a caller whether an address is known or a link was valid.
import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const submitPortalDsr = jest.fn();
const verifyPortalDsr = jest.fn();
jest.unstable_mockModule("../../../src/services/dsr-portal.service.js", () => ({ submitPortalDsr, verifyPortalDsr }));
jest.unstable_mockModule("../../../src/routes/publicPortal.routes.js", () => ({
    resolvePortalTenant: (req) => (String(req.hostname).toLowerCase() === "careers.test" ? TENANT : null),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const { privacyPortalRouter, resetPrivacyPortalRateLimits, PRIVACY_PORTAL_LIMITS } = await import("../../../src/routes/privacy-portal.routes.js");
const { mcpCtx } = await import("../../../src/lib/requestContext.js");

const app = express();
app.use("/public", privacyPortalRouter);
const onPortal = (req) => req.set("Host", "careers.test");
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
const disabled = () => Object.assign(new Error("off"), { status: 503, code: "HR-RECRUITMENT-DSR-PORTAL-DISABLED" });

beforeEach(() => {
    jest.clearAllMocks();
    resetPrivacyPortalRateLimits();
});

describe("POST /public/privacy/requests", () => {
    it("answers 202 with one body, under the pinned tenant's portal context", async () => {
        let seen = null;
        submitPortalDsr.mockImplementation(async () => {
            seen = mcpCtx.getStore();
            return { accepted: true };
        });
        const known = await onPortal(request(app).post("/public/privacy/requests").send({ email: "a@b.co", type: "ACCESS" }));
        const unknown = await onPortal(request(app).post("/public/privacy/requests").send({ email: "zz@b.co", type: "ERASURE" }));

        expect(known.status).toBe(202);
        expect(unknown.status).toBe(202);
        expect(unknown.body).toEqual(known.body);
        expect(submitPortalDsr).toHaveBeenCalledWith({ tenantId: TENANT, body: { email: "a@b.co", type: "ACCESS" } });
        expect(seen).toMatchObject({ user: { tenantId: TENANT }, portal: true });
    });

    it("is 404 without a portal tenant, 400 on a malformed body, 503 with the flag off, a generic 500 otherwise", async () => {
        expect((await request(app).post("/public/privacy/requests").set("Host", "elsewhere.test").send({})).status).toBe(404);
        submitPortalDsr.mockRejectedValueOnce(Object.assign(new Error("A valid email address is required"), { status: 400 }));
        const bad = await onPortal(request(app).post("/public/privacy/requests").send({ email: "x" }));
        expect(bad.status).toBe(400);
        expect(bad.body.message).toBe("A valid email address is required");
        submitPortalDsr.mockRejectedValueOnce(disabled());
        expect((await onPortal(request(app).post("/public/privacy/requests").send({}))).status).toBe(503);
        submitPortalDsr.mockRejectedValueOnce(new Error("db password=hunter2"));
        const boom = await onPortal(request(app).post("/public/privacy/requests").send({}));
        expect(boom.status).toBe(500);
        expect(JSON.stringify(boom.body)).not.toContain("hunter2");
    });

    it("rate-limits intake per IP", async () => {
        submitPortalDsr.mockResolvedValue({ accepted: true });
        const statuses = [];
        for (let i = 0; i <= PRIVACY_PORTAL_LIMITS.dsrSubmit; i += 1) {
            statuses.push((await onPortal(request(app).post("/public/privacy/requests").send({ email: "a@b.co", type: "ACCESS" }))).status);
        }
        expect(statuses.slice(0, -1).every((s) => s === 202)).toBe(true);
        expect(statuses.at(-1)).toBe(429);
    });
});

describe("/public/privacy/requests/verify", () => {
    it("GET renders the same neutral page whether the link was valid, invalid or failed", async () => {
        verifyPortalDsr.mockResolvedValueOnce({ verified: true, requestId: 1 });
        const ok = await onPortal(request(app).get(`/public/privacy/requests/verify?token=${TOKEN}`));
        verifyPortalDsr.mockResolvedValueOnce({ verified: false });
        const bad = await onPortal(request(app).get("/public/privacy/requests/verify?token=nope"));
        verifyPortalDsr.mockRejectedValueOnce(new Error("db down"));
        const failed = await onPortal(request(app).get(`/public/privacy/requests/verify?token=${TOKEN}`));

        for (const res of [ok, bad, failed]) {
            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toMatch(/text\/html/);
            expect(res.headers["cache-control"]).toBe("no-store");
            expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
        }
        expect(bad.text).toBe(ok.text);
        expect(failed.text).toBe(ok.text);
        expect(verifyPortalDsr).toHaveBeenCalledWith({ tenantId: TENANT, token: TOKEN });
    });

    it("POST takes the token from the query or the body and answers one neutral JSON body", async () => {
        verifyPortalDsr.mockResolvedValueOnce({ verified: true });
        const a = await onPortal(request(app).post(`/public/privacy/requests/verify?token=${TOKEN}`));
        verifyPortalDsr.mockResolvedValueOnce({ verified: false });
        const b = await onPortal(request(app).post("/public/privacy/requests/verify").send({ token: "other" }));

        expect(a.status).toBe(200);
        expect(b.body).toEqual(a.body);
        expect(verifyPortalDsr.mock.calls.map((c) => c[0].token)).toEqual([TOKEN, "other"]);
    });

    it("answers 503 with the flag off and 404 without a portal tenant", async () => {
        verifyPortalDsr.mockRejectedValueOnce(disabled());
        expect((await onPortal(request(app).get(`/public/privacy/requests/verify?token=${TOKEN}`))).status).toBe(503);
        expect((await request(app).get(`/public/privacy/requests/verify?token=${TOKEN}`).set("Host", "x.test")).status).toBe(404);
        expect(verifyPortalDsr).toHaveBeenCalledTimes(1);
    });
});

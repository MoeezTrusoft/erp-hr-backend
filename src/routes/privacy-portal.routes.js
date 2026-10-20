// src/routes/privacy-portal.routes.js
//
// Recruitment Phase 5 (plan 6.9) — data-subject requests from the careers
// portal. Mounted by the lead under /public, OUTSIDE the /api service guard,
// next to publicPortal.routes.js, and guarded the same way:
//
//   * TENANT PINNING — the tenant comes from the portal host mapping (or the
//     trusted edge header), via publicPortal.routes.js resolvePortalTenant;
//     never from the body. No tenant is the same 404 as an unknown site.
//   * RATE LIMITS — an in-memory fixed window per IP and route class, the
//     intake class strict (it sends email), verification looser.
//   * NO ORACLE — intake answers the same 202 whether or not the address is
//     known; verification answers the same neutral page whatever the token
//     was (live, used, expired, malformed, another tenant's).
//   * TENANT CONTEXT — the handler runs in the request context pinned to the
//     resolved tenant (deny-by-default scope and FORCE RLS need it).
//
//   POST /public/privacy/requests          { email, type, details? } -> 202
//   GET  /public/privacy/requests/verify?token=   -> a neutral HTML page
//   POST /public/privacy/requests/verify?token=   (or { token }) -> neutral JSON
import express from "express";
import { mcpCtx } from "../lib/requestContext.js";
import logger from "../lib/logger.js";
import { resolvePortalTenant } from "./publicPortal.routes.js";
import { submitPortalDsr, verifyPortalDsr } from "../services/dsr-portal.service.js";

export const privacyPortalRouter = express.Router();

// ── Rate limiting (fixed window, in memory; same posture as the portal) ─────
const WINDOW_MS = 60_000;
export const PRIVACY_PORTAL_LIMITS = Object.freeze({ dsrSubmit: 5, dsrVerify: 30 });
const buckets = new Map();
let lastSweep = Date.now();

function rateLimit(routeClass) {
    const limit = PRIVACY_PORTAL_LIMITS[routeClass];
    return (req, res, next) => {
        const now = Date.now();
        if (now - lastSweep > WINDOW_MS) {
            for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
            lastSweep = now;
        }
        const key = `${routeClass}:${req.ip ?? "unknown"}`;
        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + WINDOW_MS };
            buckets.set(key, bucket);
        }
        bucket.count += 1;
        res.setHeader("X-RateLimit-Limit", String(limit));
        res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
        if (bucket.count > limit) {
            res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
            return res.status(429).json({ success: false, message: "Too many requests" });
        }
        return next();
    };
}

/** Test hook: forget every bucket. */
export const resetPrivacyPortalRateLimits = () => buckets.clear();

const NOT_FOUND = Object.freeze({ success: false, message: "Not found" });
const UNAVAILABLE = Object.freeze({ success: false, message: "Privacy requests are not available" });
const ACCEPTED = Object.freeze({
    success: true,
    data: { received: true, message: "If this address is known to us, a confirmation link is on its way. Please follow it within 48 hours." },
});
const VERIFY_NEUTRAL = Object.freeze({
    success: true,
    data: { received: true, message: "Thank you. If the link was valid, your request has been confirmed and we will respond within 30 days." },
});

const isDisabled = (err) => err?.code === "HR-RECRUITMENT-DSR-PORTAL-DISABLED";

const pinned = (routeClass, handler) => [
    rateLimit(routeClass),
    async (req, res) => {
        const tenantId = resolvePortalTenant(req);
        if (!tenantId) return res.status(404).json(NOT_FOUND);
        return mcpCtx.run({ user: { tenantId }, portal: true }, async () => await handler(req, res, tenantId));
    },
];

// The verification page: static, no scripts, nothing that differs by outcome.
const VERIFY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy request</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.4rem">Thank you</h1>
<p>If the link was valid, your privacy request has been confirmed and we will respond within 30 days.</p>
<p>If you did not make this request, you can ignore this page.</p>
</body></html>`;

function sendVerifyPage(res, status = 200) {
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.status(status).type("html").send(VERIFY_PAGE);
}

// POST /public/privacy/requests — record the request and email the link.
privacyPortalRouter.post(
    "/privacy/requests",
    express.json({ limit: "16kb" }),
    ...pinned("dsrSubmit", async (req, res, tenantId) => {
        try {
            await submitPortalDsr({ tenantId, body: req.body ?? {} });
            return res.status(202).json(ACCEPTED);
        } catch (err) {
            if (isDisabled(err)) return res.status(503).json(UNAVAILABLE);
            const status = Number(err?.status) || 500;
            // A malformed request is the requester's to fix and reveals nothing
            // about the address; anything else is the same generic failure.
            if (status === 400) return res.status(400).json({ success: false, message: err.message });
            logger.error({ err: err?.message, code: err?.code }, "privacy request intake failed");
            return res.status(500).json({ success: false, message: "Something went wrong" });
        }
    }),
);

async function verify(req, tenantId) {
    const token = typeof req.query?.token === "string" ? req.query.token : req.body?.token;
    try {
        await verifyPortalDsr({ tenantId, token });
        return "ok";
    } catch (err) {
        if (isDisabled(err)) return "disabled";
        // Every other failure looks like an invalid link on the wire.
        logger.error({ err: err?.message, code: err?.code }, "privacy request verification failed");
        return "ok";
    }
}

// GET /public/privacy/requests/verify?token= — the emailed link, opened directly.
privacyPortalRouter.get(
    "/privacy/requests/verify",
    ...pinned("dsrVerify", async (req, res, tenantId) => {
        const outcome = await verify(req, tenantId);
        if (outcome === "disabled") return res.status(503).json(UNAVAILABLE);
        return sendVerifyPage(res);
    }),
);

// POST /public/privacy/requests/verify — the portal page posts the token.
privacyPortalRouter.post(
    "/privacy/requests/verify",
    express.json({ limit: "4kb" }),
    ...pinned("dsrVerify", async (req, res, tenantId) => {
        const outcome = await verify(req, tenantId);
        if (outcome === "disabled") return res.status(503).json(UNAVAILABLE);
        res.setHeader("Cache-Control", "no-store");
        return res.json(VERIFY_NEUTRAL);
    }),
);

export default privacyPortalRouter;

// src/routes/publicPortal.routes.js
//
// Phase 5 / decision record §3.1 — the PUBLIC careers-portal API.
//
// Mounted OUTSIDE the /api internal-service guard (like the device intake
// router), because an anonymous visitor cannot present a gateway service-JWT —
// §3.1 makes discovery and application login-free. "Public" does not mean
// unguarded; the guards here are the ones the internet actually requires:
//
//   * TENANT PINNING — every request is scoped to ONE tenant, resolved from the
//     portal host mapping (HR_PORTAL_HOSTS, "host=tenantUuid" pairs) or the
//     X-Portal-Tenant header set by the trusted edge. Never from a
//     candidate-supplied body field; a request with no resolvable tenant is 404
//     like any unknown site, not an error that confirms the portal exists.
//   * RATE LIMITING — an in-memory fixed-window limiter, keyed by IP and route
//     class. Deliberately dependency-free: the deploy has Redis, but the portal
//     must degrade to "closed" rather than "open" if Redis is down, and a
//     per-process limiter still caps the blast radius of a credential-stuffing
//     sweep against one pod. The application endpoint gets the strictest class.
//   * UNIFORM FAILURES — unknown job, closed job and cross-tenant job all
//     return the same 404 body, so the API cannot be probed for internal ids
//     (§3.4's rule, applied to jobs as well as emails).
import express from "express";
import { listPublicJobs, getPublicJob, submitPublicApplication } from "../services/publicPortal.service.js";
import { consumeEmailVerification } from "../services/candidateVerification.service.js";
import logger from "../lib/logger.js";

const router = express.Router();

// ── Tenant resolution ────────────────────────────────────────────────────────
//
// HR_PORTAL_HOSTS format: "careers.acme.com=uuid1,jobs.example.org=uuid2".
// Host matching is exact and lower-cased; the X-Portal-Tenant header is only
// honored from the trusted edge (the same cluster that injects internal
// secrets), which in this slice means requests that arrived through the
// gateway's rewrite — a direct external caller cannot set it and reach this
// router unless the operator exposed the port, which is a deployment error the
// limiter will make noisy anyway.
const parseHostMap = () => {
    const raw = process.env.HR_PORTAL_HOSTS || "";
    const map = new Map();
    for (const pair of raw.split(",")) {
        const [host, tenant] = pair.split("=").map((s) => s && s.trim());
        if (host && tenant) map.set(host.toLowerCase(), tenant);
    }
    return map;
};

export function resolvePortalTenant(req) {
    const host = String(req.hostname || "").toLowerCase();
    const tenant = parseHostMap().get(host);
    if (tenant) return tenant;
    // Trusted-edge override: only meaningful behind the gateway, which strips
    // this header from public traffic before proxying.
    if (process.env.HR_PORTAL_TRUST_EDGE_HEADER === "true") {
        const headerTenant = req.get("X-Portal-Tenant");
        if (headerTenant && /^[0-9a-f-]{36}$/i.test(headerTenant)) return headerTenant;
    }
    return null;
}

// ── Rate limiting (fixed window, in memory) ─────────────────────────────────
const WINDOW_MS = 60_000;
const LIMITS = Object.freeze({
    read: 120, // listing/detail — generous, cached pages
    apply: 6, // applications — the abuse target
});

const buckets = new Map(); // key → { count, resetAt }
let lastSweep = Date.now();

function rateLimit(routeClass) {
    return (req, res, next) => {
        const key = `${routeClass}:${req.ip ?? "unknown"}`;
        const now = Date.now();
        // Occasional sweep so the map cannot grow without bound under a
        // distributed sweep with spoofed IPs.
        if (now - lastSweep > WINDOW_MS) {
            for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
            lastSweep = now;
        }
        const bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
            res.setHeader("X-RateLimit-Limit", String(LIMITS[routeClass]));
            res.setHeader("X-RateLimit-Remaining", String(LIMITS[routeClass] - 1));
            return next();
        }
        bucket.count += 1;
        res.setHeader("X-RateLimit-Limit", String(LIMITS[routeClass]));
        res.setHeader("X-RateLimit-Remaining", String(Math.max(0, LIMITS[routeClass] - bucket.count)));
        if (bucket.count > LIMITS[routeClass]) {
            res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
            return res.status(429).json({ success: false, message: "Too many requests" });
        }
        return next();
    };
}

const guard = (routeClass, handler) => [
    rateLimit(routeClass),
    async (req, res) => {
        const tenantId = resolvePortalTenant(req);
        if (!tenantId) {
            // 404, not 401/403: a tenant-less request is "no such site".
            return res.status(404).json({ success: false, message: "Not found" });
        }
        try {
            return await handler(req, res, tenantId);
        } catch (err) {
            const status = Number(err?.status) || 500;
            if (status >= 500) logger.error({ err: err?.message, route: req.path }, "public portal route failed");
            // Error bodies are uniform on purpose — see the header comment.
            return res.status(status).json({
                success: false,
                message: status >= 500 ? "Something went wrong" : err.message,
                ...(err?.details ? { details: err.details } : {}),
            });
        }
    },
];

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /public/jobs?q= — open, eligible jobs for this portal's tenant.
router.get(
    "/jobs",
    ...guard("read", async (req, res, tenantId) => {
        const jobs = await listPublicJobs({ tenantId, prisma: (await import("../config/prisma.js")).default, q: req.query.q ?? null });
        return res.json({ success: true, data: jobs });
    }),
);

// GET /public/jobs/:id — one job's public detail.
router.get(
    "/jobs/:id",
    ...guard("read", async (req, res, tenantId) => {
        const job = await getPublicJob({ tenantId, prisma: (await import("../config/prisma.js")).default, id: req.params.id });
        // Unknown id, closed job and cross-tenant id are all the same 404.
        if (!job) return res.status(404).json({ success: false, message: "Position not found" });
        return res.json({ success: true, data: job });
    }),
);

// POST /public/jobs/:id/apply — anonymous application intake.
router.post(
    "/jobs/:id/apply",
    express.json({ limit: "256kb" }),
    ...guard("apply", async (req, res, tenantId) => {
        const result = await submitPublicApplication({
            tenantId,
            requisitionId: req.params.id,
            body: req.body,
        });
        return res.status(201).json({ success: true, data: result });
    }),
);

// GET /public/candidates/verify-email?token= — §3.2 magic-link consumption.
// Anonymous BY DESIGN (the token IS the credential) and rate-limited like a
// read: a brute-force sweep hits the fixed window before it hits the token
// space (256-bit), and every failure returns the SAME uniform 400 — the
// endpoint cannot reveal which emails exist or which links are live (§3.4).
router.get(
    "/candidates/verify-email",
    ...guard("read", async (req, res) => {
        try {
            const result = await consumeEmailVerification({ token: req.query.token });
            return res.json({ success: true, data: result });
        } catch (err) {
            // Uniform failure body — never leak the failure class to the wire.
            const status = Number(err?.status) || 400;
            return res.status(status).json({ success: false, message: "This verification link is not valid" });
        }
    }),
);

export default router;

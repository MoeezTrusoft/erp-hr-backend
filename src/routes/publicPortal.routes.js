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
//   * TENANT CONTEXT — the handler runs inside the request context
//     (mcpCtx) pinned to the resolved tenant, exactly like the /api routes
//     after establishTenantContext. Without it the deny-by-default tenant
//     scope refuses every query (HR-4030) and FORCE-RLS reads (including the
//     do-not-contact register) see nothing.
//   * Recruitment Phase 2 — D-11 / D-16: apply, draft save and status-link
//     answer every accepted outcome (new, duplicate, do-not-contact) with the
//     same status and body.
import express from "express";
import { mcpCtx } from "../lib/requestContext.js";
import { listPublicJobs, getPublicJob, submitPublicApplication } from "../services/publicPortal.service.js";
import { consumeEmailVerification } from "../services/candidateVerification.service.js";
import { requestStatusLink, readStatusViaLink } from "../services/candidateStatus.service.js";
import {
    saveApplicationDraft,
    loadApplicationDraft,
    submitApplicationDraft,
} from "../services/applicationDraft.service.js";
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
            // The portal has no user: the context carries only the pinned tenant.
            return await mcpCtx.run({ user: { tenantId }, portal: true }, async () => await handler(req, res, tenantId));
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

// POST /public/candidates/status-link — §3.5a: request (or re-request) the
// status-tracking link. Uniform response for known and unknown addresses:
// only the REAL candidate's mailbox ever receives a link, so the endpoint
// cannot be probed for which emails have applied (§3.4).
router.post(
    "/candidates/status-link",
    express.json({ limit: "16kb" }),
    ...guard("apply", async (req, res, tenantId) => {
        try {
            const result = await requestStatusLink({ tenantId, email: req.body?.email });
            return res.json({ success: true, data: result });
        } catch (err) {
            const status = Number(err?.status) || 500;
            if (status >= 500) logger.error({ err: err?.message }, "status link request failed");
            return res.status(status).json({ success: false, message: status >= 500 ? "Something went wrong" : err.message });
        }
    }),
);

// POST /public/candidates/draft — FR-04.07 save-and-return: upsert the
// candidate's draft for one requisition and email the resume link. Auth is the
// EMAIL ITSELF (the link is the credential, like every candidate surface);
// the response is uniform and the real link goes only to the real mailbox.
router.post(
    "/candidates/draft",
    express.json({ limit: "256kb" }),
    ...guard("apply", async (req, res, tenantId) => {
        try {
            await saveApplicationDraft({
                tenantId,
                requisitionId: req.body?.requisitionId,
                email: req.body?.email,
                firstName: req.body?.firstName,
                body: req.body,
            });
            // Uniform: whether the email went out, and the draft's id, are not
            // the anonymous caller's to know (D-11 suppression looks the same).
            return res.json({ success: true, data: { saved: true } });
        } catch (err) {
            const status = Number(err?.status) || 500;
            if (status >= 500) logger.error({ err: err?.message }, "draft save failed");
            return res.status(status).json({ success: false, message: status >= 500 ? "Something went wrong" : err.message });
        }
    }),
);

// GET /public/candidates/draft?token= — load the saved draft behind the
// emailed link. Unknown/expired/submitted tokens and anonymized owners all
// render the SAME uniform body (§3.4): the endpoint cannot be probed.
router.get(
    "/candidates/draft",
    ...guard("read", async (req, res) => {
        const NOT_FOUND = { success: false, message: "This draft link is not valid" };
        try {
            const draft = await loadApplicationDraft({ token: req.query.token });
            if (!draft) return res.status(404).json(NOT_FOUND);
            return res.json({ success: true, data: draft });
        } catch (err) {
            logger.error({ err: err?.message }, "draft load failed");
            return res.status(404).json(NOT_FOUND);
        }
    }),
);

// POST /public/candidates/draft/submit — submit the draft as a real
// application THROUGH the intake gates. Failures are uniform (the same body
// as a bad link) so a stale draft reveals nothing.
router.post(
    "/candidates/draft/submit",
    express.json({ limit: "16kb" }),
    ...guard("apply", async (req, res) => {
        const NOT_FOUND = { success: false, message: "This draft link is not valid" };
        try {
            const result = await submitApplicationDraft({ token: req.body?.token });
            return res.status(201).json({ success: true, data: { received: true, requisitionId: result?.requisitionId ?? null } });
        } catch (err) {
            const status = Number(err?.status) || 400;
            if (status >= 500) logger.error({ err: err?.message }, "draft submit failed");
            // Question/eligibility refusals carry their message (actionable
            // for the candidate); anything else is the uniform link body.
            const actionable = [400, 409].includes(status) && err?.code !== "HR-PORTAL-DRAFT-INVALID";
            return res.status(status).json({
                success: false,
                message: actionable ? err.message : "This draft link is not valid",
                ...(actionable && err?.details ? { details: err.details } : {}),
            });
        }
    }),
);

// GET /public/candidates/status?token= — §3.5a: the candidate-visible view.
// A wrong, revoked or expired link — and a link-holder with no visible
// applications — all render the SAME empty body (§3.4 no-oracle); the
// candidate-visible projection (lib/candidateStatusView.js) never exposes
// internal stages, rejection reasons, comments or scores (§3.5a).
router.get(
    "/candidates/status",
    ...guard("read", async (req, res) => {
        const EMPTY = { success: true, data: { applications: [] } };
        try {
            const result = await readStatusViaLink({ token: req.query.token });
            if (!result) return res.json(EMPTY);
            return res.json({ success: true, data: result.view });
        } catch (err) {
            // A read failure must not distinguish itself from "nothing here".
            logger.error({ err: err?.message }, "status link read failed");
            return res.json(EMPTY);
        }
    }),
);

export default router;

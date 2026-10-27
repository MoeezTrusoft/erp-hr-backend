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
//   * RATE LIMITING — a fixed-window limiter keyed by IP and route class,
//     shared by every pod through Redis (lib/rate-limit.util.js). If Redis is
//     down it degrades to per-process memory windows, never to "open", so a
//     credential-stuffing sweep is still capped per pod. The application
//     endpoint gets the strictest class.
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
//   * Recruitment Phase 3a — interview self-scheduling: the emailed choose
//     link reads the offered slots and confirms one. An unknown, expired,
//     cancelled or confirmed link (and an offer from another tenant than the
//     portal's) is the same 404; a slot that is no longer free is the same
//     409 "pick another" whatever made it unavailable.
//   * Recruitment Phase 6 — the same link can decline every offered slot
//     (POST /candidates/interview-slots/decline { token, reason? }): one 200
//     for a live link, the same 404 for every other one.
//   * Recruitment Phase 7 — the careers resume upload
//     (POST /candidates/resume { fileName, mimeType, contentBase64,
//     draftToken? }): PDF only, the portal upload rules, its own rate budget.
//     The answer is an opaque `resumeRef` for this tenant (bound to the draft
//     when a draft token is given), never a storage key. Draft save and the
//     direct apply take that reference; a typed resumeMediaId is a 400.
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
import { getSlotOfferForCandidate, confirmSlotOffer, declineSlotOffer } from "../services/interview-slot-offer.service.js";
import { PORTAL_RESUME_CODES, resumeMediaIdForApply, uploadPortalResume } from "../services/portal-resume-upload.service.js";
import logger from "../lib/logger.js";
import { rateLimit as sharedRateLimit } from "../lib/rate-limit.util.js";

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

// ── Rate limiting (fixed window, shared through Redis) ──────────────────────
const WINDOW_MS = 60_000;
const LIMITS = Object.freeze({
    read: 120, // listing/detail — generous, cached pages
    apply: 6, // applications — the abuse target
    // Phase 3a — the interview slot link has its own budgets, so a candidate
    // choosing a time never spends (or is blocked by) the application budget.
    slotRead: 60,
    slotConfirm: 10,
    // Phase 6 — declining every slot has its own budget too.
    slotDecline: 10,
    // Phase 7 — the resume upload (up to 10 MB each) spends neither the
    // application budget nor the reader's.
    resumeUpload: 6,
});

const limiters = Object.freeze(Object.fromEntries(
    Object.entries(LIMITS).map(([routeClass, limit]) => [
        routeClass,
        sharedRateLimit({ routeClass: `portal:${routeClass}`, limit, windowMs: WINDOW_MS }),
    ]),
));
const rateLimit = (routeClass) => limiters[routeClass];

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
        // Phase 7 — a resume only through this tenant's upload reference.
        const resumeMediaId = resumeMediaIdForApply({ tenantId, body: req.body });
        const result = await submitPublicApplication({
            tenantId,
            requisitionId: req.params.id,
            body: req.body,
            resumeMediaId,
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
            return res.status(status).json({
                success: false,
                message: status >= 500 ? "Something went wrong" : err.message,
                // Phase 7 — a refused resume reference carries its code.
                ...(status < 500 && err?.details ? { details: err.details } : {}),
            });
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

// POST /public/candidates/resume — Phase 7: store the visitor's resume (PDF,
// at most 10 MB, base64 in JSON) and answer an opaque reference for the draft
// save or the apply. A refused file is a 400 with details { code, reason }; a
// bad draft token is a 400 with its code; DAM being down is a 503 "try again".
const RESUME_TRY_AGAIN = Object.freeze({
    success: false,
    message: "We could not store your resume right now. Please try again in a few minutes.",
    details: { code: PORTAL_RESUME_CODES.UNAVAILABLE },
});
router.post(
    "/candidates/resume",
    express.json({ limit: "15mb" }),
    ...guard("resumeUpload", async (req, res, tenantId) => {
        try {
            const body = req.body ?? {};
            const result = await uploadPortalResume({
                tenantId,
                resume: { fileName: body.fileName, mimeType: body.mimeType, contentBase64: body.contentBase64 },
                draftToken: body.draftToken ?? null,
            });
            return res.status(201).json({ success: true, data: result });
        } catch (err) {
            const status = Number(err?.status) || 500;
            if (status === 404) return res.status(404).json({ success: false, message: "Not found" });
            if (status >= 500) {
                logger.error({ err: err?.message, code: err?.code ?? null }, "portal resume upload failed");
                return res.status(503).json(RESUME_TRY_AGAIN);
            }
            return res.status(status).json({ success: false, message: err.message, ...(err?.details ? { details: err.details } : {}) });
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

// ── Recruitment Phase 3a — interview self-scheduling ────────────────────────
//
// A separate router (mounted next to this one at /public) so the portal's
// pinned route inventory stays as it is; it shares the guard above: tenant
// pinning, the portal context, the limiter (its own classes) and uniform
// failures.
export const interviewSlotsRouter = express.Router();

const SLOT_LINK_NOT_FOUND = Object.freeze({ success: false, message: "This interview link is not valid" });
// Phase 6 hardening: the decline could not be recorded (an outage), not a dead link.
const SLOT_DECLINE_TRY_AGAIN = Object.freeze({
    success: false,
    message: "We could not record your answer right now. Please try again in a few minutes.",
});
const SLOT_TAKEN = Object.freeze({ success: false, message: "This time is no longer available, please pick another" });

// GET /public/candidates/interview-slots?token= — the slots offered to the
// link's candidate. Every not-found reason is the same 404.
interviewSlotsRouter.get(
    "/candidates/interview-slots",
    ...guard("slotRead", async (req, res, tenantId) => {
        try {
            const view = await getSlotOfferForCandidate({ token: req.query.token, tenantId });
            if (!view) return res.status(404).json(SLOT_LINK_NOT_FOUND);
            return res.json({ success: true, data: view });
        } catch (err) {
            logger.error({ err: err?.message }, "interview slot link read failed");
            return res.status(404).json(SLOT_LINK_NOT_FOUND);
        }
    }),
);

// POST /public/candidates/interview-slots/confirm { token, slotStart } — the
// candidate picks one slot; the interview is created.
interviewSlotsRouter.post(
    "/candidates/interview-slots/confirm",
    express.json({ limit: "16kb" }),
    ...guard("slotConfirm", async (req, res, tenantId) => {
        try {
            const result = await confirmSlotOffer({ token: req.body?.token, slotStart: req.body?.slotStart, tenantId });
            if (!result) return res.status(404).json(SLOT_LINK_NOT_FOUND);
            return res.json({ success: true, data: result });
        } catch (err) {
            if (err?.code === "HR-RECRUITMENT-SLOT-UNAVAILABLE") return res.status(409).json(SLOT_TAKEN);
            logger.error({ err: err?.message, code: err?.code }, "interview slot confirm failed");
            return res.status(404).json(SLOT_LINK_NOT_FOUND);
        }
    }),
);

// POST /public/candidates/interview-slots/decline { token, reason? } — Phase 6:
// the candidate declines every offered slot (reason: one of
// SLOT_DECLINE_REASONS, optional). A malformed reason is a 400 checked before
// the token is looked at; every not-found link is the same 404.
interviewSlotsRouter.post(
    "/candidates/interview-slots/decline",
    express.json({ limit: "4kb" }),
    ...guard("slotDecline", async (req, res, tenantId) => {
        try {
            const result = await declineSlotOffer({ token: req.body?.token, reason: req.body?.reason, tenantId });
            if (!result) return res.status(404).json(SLOT_LINK_NOT_FOUND);
            return res.json({ success: true, data: { declined: true } });
        } catch (err) {
            if (err?.code === "HR-RECRUITMENT-SLOT-DECLINE-REASON-INVALID") {
                return res.status(400).json({ success: false, message: err.message });
            }
            const status = Number(err?.status);
            // A refusal of the link itself (any 4xx) is the same dead link.
            if (Number.isInteger(status) && status >= 400 && status < 500) return res.status(404).json(SLOT_LINK_NOT_FOUND);
            // An outage is not a dead link: the candidate is told to try again,
            // so a decline is not silently lost (Phase 6 hardening). The body is
            // the same for every token, so it reveals nothing about the person.
            logger.error({ err: err?.message, code: err?.code }, "interview slot decline failed");
            return res.status(503).json(SLOT_DECLINE_TRY_AGAIN);
        }
    }),
);

export default router;

// src/routes/invitation-response.routes.js
//
// Recruitment Phase 6 (flag `invitationLinks`) — the candidate answers a talent
// pool invitation from the emailed link. Mounted by the lead under /public,
// OUTSIDE the /api service guard, next to publicPortal.routes.js, and guarded
// the same way:
//
//   * TENANT PINNING — the tenant comes from the portal host mapping (or the
//     trusted edge header) via publicPortal.routes.js resolvePortalTenant,
//     never from the body; no tenant is the same 404 as an unknown site.
//   * RATE LIMITS — a fixed window per IP and route class, shared by every
//     pod through Redis (lib/rate-limit.util.js; memory when Redis is down),
//     the answer class strict (it writes and may create an application).
//   * NO ORACLE — a malformed, unknown, expired, used or other-tenant token is
//     the same 404 body on both routes. A live link shows the role title only.
//   * TENANT CONTEXT — the handler runs in the request context pinned to the
//     resolved tenant (deny-by-default scope and FORCE RLS need it).
//   * GET NEVER ANSWERS — mail scanners open links; only the POST the portal
//     page sends records an answer.
//
//   GET  /public/invitations/respond?token=          -> { jobTitle, expiresAt }
//   POST /public/invitations/respond { token, answer: ACCEPT|DECLINE, note? }
//                                                    -> { answer, applicationReceived }
import express from "express";
import { mcpCtx } from "../lib/requestContext.js";
import logger from "../lib/logger.js";
import { rateLimit as sharedRateLimit, resetRateLimitMemory } from "../lib/rate-limit.util.js";
import { resolvePortalTenant } from "./publicPortal.routes.js";
import { getInvitationForCandidate, respondViaInvitationLink } from "../services/invitation-response.service.js";

export const invitationResponseRouter = express.Router();

// ── Rate limiting (fixed window, shared through Redis: lib/rate-limit.util.js)
const WINDOW_MS = 60_000;
export const INVITATION_RESPONSE_LIMITS = Object.freeze({ inviteRead: 60, inviteAnswer: 10 });

const limiters = Object.freeze(Object.fromEntries(
    Object.entries(INVITATION_RESPONSE_LIMITS).map(([routeClass, limit]) => [
        routeClass,
        sharedRateLimit({ routeClass: `invitation:${routeClass}`, limit, windowMs: WINDOW_MS }),
    ]),
));
const rateLimit = (routeClass) => limiters[routeClass];

/** Test hook: forget every in-memory window. */
export const resetInvitationResponseRateLimits = () => resetRateLimitMemory();

const NOT_FOUND = Object.freeze({ success: false, message: "Not found" });
const LINK_NOT_VALID = Object.freeze({ success: false, message: "This invitation link is not valid" });
const UNAVAILABLE = Object.freeze({ success: false, message: "Invitation responses are not available" });
const ROLE_CLOSED = Object.freeze({ success: false, message: "This role is no longer open for applications" });
const FAILED = Object.freeze({ success: false, message: "Something went wrong" });

const pinned = (routeClass, handler) => [
    rateLimit(routeClass),
    async (req, res) => {
        const tenantId = resolvePortalTenant(req);
        if (!tenantId) return res.status(404).json(NOT_FOUND);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        return mcpCtx.run({ user: { tenantId }, portal: true }, async () => await handler(req, res, tenantId));
    },
];

// Every failure maps to one of a handful of fixed bodies; none carries the
// service's own message except a malformed body (the caller's to fix).
function sendFailure(res, err, route) {
    if (err?.code === "HR-RECRUITMENT-INVITATION-LINKS-DISABLED") return res.status(503).json(UNAVAILABLE);
    if (err?.code === "HR-RECRUITMENT-INVITATION-ROLE-CLOSED") return res.status(409).json(ROLE_CLOSED);
    const status = Number(err?.status) || 500;
    if (status === 400) return res.status(400).json({ success: false, message: err.message });
    if (status >= 500) {
        logger.error({ errMessage: err?.message, code: err?.code ?? null, route }, "invitation response route failed");
        return res.status(500).json(FAILED);
    }
    return res.status(404).json(LINK_NOT_VALID);
}

// GET /public/invitations/respond?token= — what the portal page shows first.
invitationResponseRouter.get(
    "/invitations/respond",
    ...pinned("inviteRead", async (req, res, tenantId) => {
        try {
            const token = typeof req.query?.token === "string" ? req.query.token : null;
            const view = await getInvitationForCandidate({ tenantId, token });
            if (!view) return res.status(404).json(LINK_NOT_VALID);
            return res.json({ success: true, data: view });
        } catch (err) {
            return sendFailure(res, err, "GET /invitations/respond");
        }
    }),
);

// POST /public/invitations/respond { token, answer, note? } — the answer.
invitationResponseRouter.post(
    "/invitations/respond",
    express.json({ limit: "8kb" }),
    ...pinned("inviteAnswer", async (req, res, tenantId) => {
        try {
            const body = req.body ?? {};
            const token = typeof body.token === "string" ? body.token : null;
            const result = await respondViaInvitationLink({ tenantId, token, body: { answer: body.answer, note: body.note } });
            if (!result) return res.status(404).json(LINK_NOT_VALID);
            return res.json({ success: true, data: result });
        } catch (err) {
            return sendFailure(res, err, "POST /invitations/respond");
        }
    }),
);

export default invitationResponseRouter;

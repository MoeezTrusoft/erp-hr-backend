// src/routes/kiosk.routes.js
//
// Phase 3b — the kiosk test REST surface (plan 7.6), mounted at /kiosk/v1
// OUTSIDE the /api internal-service guard, like the careers portal: a kiosk
// has no ERP user and cannot present a gateway service-JWT.
//
//   * WORKSTATION TOKEN. Every request carries X-Kiosk-Token, verified by
//     verifyWorkstationToken (only ACTIVE, registered workstations; a revoked
//     token stops at once). The workstation's tenant is pinned in the request
//     context (mcpCtx) for the handler, so tenant scope and FORCE-RLS work as
//     on /api. Nothing the kiosk sends chooses the tenant.
//   * SESSION TOKEN. Every route but start also carries X-Kiosk-Session, the
//     bearer token start returned once; the session must belong to the calling
//     workstation (test-session.service.js records a DEVICE_CHANGE otherwise).
//   * RATE LIMITS. Fixed windows per IP and per workstation, shared by every
//     pod through Redis (lib/rate-limit.util.js; memory when Redis is down,
//     never unlimited). Start has the strictest budget: it is the six-digit
//     code's guessing surface.
//   * RESUME (Phase 6, flag kioskResume). POST sessions/resume { code }
//     exchanges a reception-issued resume code for a fresh session token after
//     a kiosk crash; it shares start's budget (the same six-digit guessing
//     surface) and, like start, carries no session token.
//   * UNIFORM FAILURES. A bad workstation token, code, session token, binding
//     or state, and the feature flag being off, are all the same 404 body. A
//     malformed body is a 400, too many requests a 429, and nothing else
//     reaches the wire.
import express from "express";
import { mcpCtx } from "../lib/requestContext.js";
import logger from "../lib/logger.js";
import { consumeRateLimit, resetRateLimitMemory } from "../lib/rate-limit.util.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import { verifyWorkstationToken } from "../services/test-workstation.service.js";
import {
    getKioskItem,
    getKioskSessionState,
    kioskHeartbeat,
    recordKioskIntegrityEvents,
    resumeKioskSession,
    saveKioskResponse,
    startKioskSession,
    submitKioskSession,
} from "../services/test-session.service.js";

const router = express.Router();

// ── Rate limiting (fixed window, shared through Redis) ──────────────────────
const WINDOW_MS = 60_000;
// Per minute: [per IP, per workstation].
const LIMITS = Object.freeze({
    start: { ip: 20, workstation: 10 },
    session: { ip: 600, workstation: 300 },
});

/** Count one hit against `key` (hashed by the util); false once the window's budget is spent. */
async function consume(routeClass, key, limit) {
    const result = await consumeRateLimit({ routeClass, key, limit, windowMs: WINDOW_MS });
    return result.allowed;
}

/** Tests only: forget every in-memory window. */
export function resetKioskRateLimits() {
    resetRateLimitMemory();
}

const NOT_FOUND = Object.freeze({ success: false, message: "Not found" });
const notFound = (res) => res.status(404).json(NOT_FOUND);
const tooMany = (res) => res.status(429).json({ success: false, message: "Too many requests" });

async function workstationFor(req) {
    const raw = req.get("X-Kiosk-Token");
    if (typeof raw !== "string" || raw.length < 16 || raw.length > 512) return null;
    try {
        // The token names its tenant; the lookup runs before one is known.
        const ws = await mcpCtx.run({ system: true, kiosk: true }, async () => await verifyWorkstationToken(raw));
        if (!ws?.id || !ws?.tenantId || (ws.status && ws.status !== "ACTIVE")) return null;
        return ws;
    } catch (err) {
        logger.warn({ component: "kiosk", errMessage: err?.message }, "kiosk: workstation token check failed");
        return null;
    }
}

function guard(routeClass, handler) {
    return async (req, res) => {
        if (!(await consume(`kiosk:${routeClass}:ip`, req.ip ?? "unknown", LIMITS[routeClass].ip))) return tooMany(res);
        if (!isRecruitmentFlagEnabled("onsiteTest")) return notFound(res);
        const workstation = await workstationFor(req);
        if (!workstation) return notFound(res);
        if (!(await consume(`kiosk:${routeClass}:ws`, String(workstation.id), LIMITS[routeClass].workstation))) return tooMany(res);
        const tenantId = workstation.tenantId;
        const sessionToken = req.get("X-Kiosk-Session") ?? null;
        try {
            const data = await mcpCtx.run(
                { user: { tenantId }, kiosk: true },
                async () => await handler({ req, tenantId, workstation, sessionToken, now: new Date() }),
            );
            return res.json({ success: true, data });
        } catch (err) {
            const status = Number(err?.status) || 500;
            if (status === 400) return res.status(400).json({ success: false, message: err.message, code: err.code });
            if (status >= 500) {
                logger.error({ component: "kiosk", route: req.path, errMessage: err?.message }, "kiosk route failed");
                return res.status(500).json({ success: false, message: "Something went wrong" });
            }
            // A blueprint whose pool is too shallow (409) is the recruiter's to
            // fix; the kiosk still sees only the uniform answer.
            if (status !== 404) logger.warn({ component: "kiosk", route: req.path, code: err?.code }, "kiosk request refused");
            return notFound(res);
        }
    };
}

router.use(express.json({ limit: "32kb" }));

router.post(
    "/sessions/start",
    guard("start", async ({ req, tenantId, workstation, now }) =>
        await startKioskSession({ tenantId, workstation, code: req.body?.code, consent: req.body?.consent, now })),
);

router.post(
    "/sessions/resume",
    guard("start", async ({ req, tenantId, workstation, now }) =>
        await resumeKioskSession({ tenantId, workstation, code: req.body?.code, now })),
);

router.get(
    "/sessions/:id",
    guard("session", async ({ req, tenantId, workstation, sessionToken, now }) =>
        await getKioskSessionState({ tenantId, workstation, sessionId: req.params.id, sessionToken, now })),
);

router.get(
    "/sessions/:id/items/:n",
    guard("session", async ({ req, tenantId, workstation, sessionToken, now }) =>
        await getKioskItem({ tenantId, workstation, sessionId: req.params.id, sessionToken, n: req.params.n, now })),
);

router.put(
    "/sessions/:id/responses/:itemRef",
    guard("session", async ({ req, tenantId, workstation, sessionToken, now }) =>
        await saveKioskResponse({
            tenantId,
            workstation,
            sessionId: req.params.id,
            sessionToken,
            itemRef: req.params.itemRef,
            answer: req.body?.answer,
            flagged: req.body?.flagged,
            timeSpentSec: req.body?.timeSpentSec,
            now,
        })),
);

router.post(
    "/sessions/:id/heartbeat",
    guard("session", async ({ req, tenantId, workstation, sessionToken, now }) =>
        await kioskHeartbeat({ tenantId, workstation, sessionId: req.params.id, sessionToken, now })),
);

router.post(
    "/sessions/:id/integrity-events",
    guard("session", async ({ req, tenantId, workstation, sessionToken, now }) =>
        await recordKioskIntegrityEvents({ tenantId, workstation, sessionId: req.params.id, sessionToken, body: req.body, now })),
);

router.post(
    "/sessions/:id/submit",
    guard("session", async ({ req, tenantId, workstation, sessionToken, now }) =>
        await submitKioskSession({ tenantId, workstation, sessionId: req.params.id, sessionToken, confirm: req.body?.confirm, now })),
);

// Anything else under /kiosk/v1 is the same 404.
router.use((req, res) => notFound(res));

// A body the JSON parser refuses is a plain 400; nothing else leaks.
// Express knows an error handler by its four parameters.
router.use((err, req, res, _next) => {
    if (Number(err?.status) === 400 || err?.type === "entity.parse.failed") {
        return res.status(400).json({ success: false, message: "Invalid request" });
    }
    if (Number(err?.status) === 413) return res.status(413).json({ success: false, message: "Request too large" });
    logger.error({ component: "kiosk", errMessage: err?.message }, "kiosk request failed");
    return res.status(500).json({ success: false, message: "Something went wrong" });
});

export const kioskRouter = router;
export default router;

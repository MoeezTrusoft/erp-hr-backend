// src/routes/complianceHealth.routes.js — A.6 · GET /compliance.
//
// readyz-style structured conformance assertion. Returns an object asserting
// this service is conformant on the controls that matter for the fabric:
//   * signingKey  — the service-JWT verify key is present (the EdDSA registry
//                   resolves ≥1 kid), so inbound service-JWTs can be verified.
//   * outbox      — the outbox dispatcher heartbeat is fresh (HR has an outbox),
//                   so emitted events are actually being drained to the stream.
//   * keyExpiry   — no configured key/cert is expired (or expiring is surfaced).
//
// 200 when ALL checks pass; 503 + reasons[] when any fail. Mirrors the existing
// createHealthRouter factory + the pino logger. All probes are injected so the
// route is unit-testable without a real key registry / Redis, and the endpoint
// NEVER throws — a rejecting probe degrades to a 503 reason.
import express from 'express';

import defaultLogger from '../lib/logger.js';
import { knownKids as defaultKnownKids } from '../lib/serviceJwtKeys.js';
import { readDispatcherHeartbeat } from '../jobs/outbox.dispatcher.js';

// Default verify-key expiry probe. HR verifies inbound service-JWTs with EdDSA
// public keys (no local cert with an expiry to track), so the default reports
// ok=true. The hook stays injectable so a future signing key / cert with an
// expiry can be asserted here without touching the route.
function defaultKeyExpiry() {
    return { ok: true, soonestExpiry: null };
}

// Default outbox heartbeat probe — reads the in-process dispatcher heartbeat.
async function defaultOutboxHeartbeat() {
    return readDispatcherHeartbeat();
}

/**
 * Build the /compliance router.
 *
 * @param {object} [deps]
 * @param {() => string[]} [deps.knownKids]          resolves loaded verify-key kids.
 * @param {() => Promise<object>} [deps.outboxHeartbeat]  resolves { ok, lastBeatMs, staleMs }.
 * @param {() => object} [deps.keyExpiry]            resolves { ok, soonestExpiry, expired? }.
 * @param {() => Date} [deps.now]
 * @param {object} [deps.logger]
 */
export function createComplianceHealthRouter({
    knownKids = defaultKnownKids,
    outboxHeartbeat = defaultOutboxHeartbeat,
    keyExpiry = defaultKeyExpiry,
    now = () => new Date(),
    logger = defaultLogger,
} = {}) {
    const router = express.Router();

    router.get('/compliance', async (_req, res) => {
        const checks = {};
        const reasons = [];

        // 1) signing/verify key present.
        try {
            const kids = knownKids() || [];
            if (kids.length > 0) {
                checks.signingKey = { status: 'ok', kids: kids.length };
            } else {
                checks.signingKey = { status: 'fail', error: 'no service-JWT verify key loaded' };
                reasons.push('signing/verify key missing: SERVICE_JWT_PUBLIC_KEYS_JSON has no usable EdDSA key');
            }
        } catch (err) {
            checks.signingKey = { status: 'fail', error: err?.message || 'verify key probe failed' };
            reasons.push('signing/verify key probe failed');
        }

        // 2) outbox dispatcher heartbeat.
        try {
            const hb = await outboxHeartbeat();
            if (hb?.ok) {
                checks.outbox = { status: 'ok', staleMs: hb.staleMs ?? null };
            } else {
                checks.outbox = {
                    status: 'fail',
                    staleMs: hb?.staleMs ?? null,
                    lastBeatMs: hb?.lastBeatMs ?? null,
                };
                reasons.push('outbox dispatcher heartbeat stale or never recorded');
            }
        } catch (err) {
            checks.outbox = { status: 'fail', error: err?.message || 'outbox heartbeat probe failed' };
            reasons.push('outbox dispatcher heartbeat probe failed');
        }

        // 3) key/cert expiry.
        try {
            const exp = keyExpiry() || {};
            if (exp.ok) {
                checks.keyExpiry = { status: 'ok', soonestExpiry: exp.soonestExpiry ?? null };
            } else {
                checks.keyExpiry = { status: 'fail', soonestExpiry: exp.soonestExpiry ?? null };
                reasons.push(
                    exp.expired
                        ? `key/cert expired (soonestExpiry=${exp.soonestExpiry ?? 'unknown'})`
                        : `key/cert expiry not conformant (soonestExpiry=${exp.soonestExpiry ?? 'unknown'})`
                );
            }
        } catch (err) {
            checks.keyExpiry = { status: 'fail', error: err?.message || 'key expiry probe failed' };
            reasons.push('key/cert expiry probe failed');
        }

        const conformant = reasons.length === 0;
        const httpStatus = conformant ? 200 : 503;
        if (!conformant) {
            logger.warn?.({ reasons }, 'compliance check not conformant');
        }
        res.status(httpStatus).json({
            status: conformant ? 'conformant' : 'not_conformant',
            service: 'erp-hr-backend',
            checks,
            reasons,
            timestamp: now().toISOString(),
        });
    });

    return router;
}

export default createComplianceHealthRouter;

// src/middlewares/internalService.middleware.js — A-HR-SERVICE-JWT-INBOUND.
//
// Protects /api from direct callers. Accepts EITHER of two inbound
// credentials, in this order of preference:
//
//   1. `X-Service-Authorization: Bearer <jwt>` — the gateway's service
//      JWT (HMAC, verified by src/lib/serviceJwt.js). On success
//      req.internalService is populated with normalized claims.
//
//   2. `X-Internal-Secret: <secret>` — the transitional shared-secret
//      fallback. This path remains supported until RBAC's sunset criteria
//      are met (see docs/rbac-x-internal-secret-sunset-readiness.md);
//      removing it is out of scope for this lane.
//
// Decision order:
//   * If the JWT header is present, verify it. On success → accept. On
//     expired/invalid → 401 (do NOT silently fall through to the legacy
//     path, otherwise a stolen-but-revoked JWT could be downgraded by
//     also sending a valid legacy secret).
//   * Else if X-Internal-Secret matches the configured value → accept.
//   * Else if neither secret is configured anywhere → 500 (this preserves
//     HR's pre-existing "Internal service secret is not configured"
//     behaviour for callers that haven't migrated to the JWT path yet).
//   * Else → 403 "Direct service access is not allowed".
//
// Health probes (/healthz, /readyz) and /metrics are mounted at paths
// outside `/api` in app.js — they never reach this code path.
//
// Failure responses:
//   401 — `{ success: false, message: "Invalid service token" }`
//   403 — `{ success: false, message: "Direct service access is not allowed" }`
//   500 — `{ success: false, message: "Internal service secret is not configured" }`
//
// Nothing in this module logs the raw token or the legacy secret value.

import logger from '../lib/logger.js';
import { extractServiceToken, verifyServiceRequest } from '../lib/serviceJwt.js';
import {
    recordInternalBoundary,
    recordServiceJwtAccept,
} from '../lib/authMetrics.js';

const LEGACY_SECRET_HEADER = 'x-internal-secret';
const SERVICE_JWT_HEADER = 'x-service-authorization';

export function internalServiceGuard(req, res, next) {
    // 1) Service JWT path: if the header is present, the verifier's
    //    outcome is authoritative. A presented JWT that fails to verify
    //    is rejected with 401 even if a legacy secret is also sent,
    //    because silently downgrading would let a revoked/expired JWT
    //    be "rescued" by an attacker who also knows the legacy value.
    if (extractServiceToken(req)) {
        const outcome = verifyServiceRequest(req);
        if (outcome.ok) {
            req.internalService = { ...outcome.context, source: 'service-jwt' };
            // T-P2.1 / X-02: the request tenant comes ONLY from the verified
            // service-JWT claim — never the spoofable x-tenant-id header. This
            // overwrites the (now-null) header-derived value on req.user so all
            // downstream consumers (which read req.user.tenantId) are scoped by
            // the verified tenant.
            // REQ-007: the tenant claim is an opaque RBAC Company.uuid STRING
            // (no longer the integer companyId). Thread it through verbatim —
            // NEVER Number()/parseInt() it. Null (role without company) stays
            // null so downstream scoping remains fail-closed.
            const verifiedTenant = req.internalService.tenantId;
            if (req.user) {
                req.user.tenantId = verifiedTenant != null ? verifiedTenant : null;
            }
            // Fleet-standard landing spot: req.tenantId mirrors the verified
            // tenant so handlers/services can read one canonical field across
            // services (alongside the existing req.user.tenantId).
            req.tenantId = verifiedTenant != null ? verifiedTenant : null;
            recordInternalBoundary({ source: 'service-jwt', outcome: 'accept' });
            recordServiceJwtAccept('hr');
            return next();
        }
        if (outcome.reason === 'expired' || outcome.reason === 'invalid') {
            logger.warn(
                { route: req.path, reason: outcome.reason },
                'service jwt rejected'
            );
            recordInternalBoundary({ source: 'rejected', outcome: 'reject' });
            return res.status(401).json({
                success: false,
                message: 'Invalid service token',
            });
        }
        // "no-secret-configured" / "no-secret-configured-nonprod" — JWT
        // verification is not available on this process. The legacy
        // X-Internal-Secret accept path has been REMOVED (cutover 2026-06-23,
        // assured by scripts/assure-cutover.mjs), so this falls through to
        // rejection rather than a secret-compare fallback.
    }

    // 2) Cutover hardening: the legacy X-Internal-Secret ACCEPT path is removed.
    //    service-JWT is the ONLY accepted internal credential. A missing
    //    SERVICE_JWT_SECRET on this process fails CLOSED (misconfiguration).
    const jwtSecretConfigured = Boolean(process.env.SERVICE_JWT_SECRET);
    if (!jwtSecretConfigured) {
        recordInternalBoundary({ source: 'rejected', outcome: 'reject' });
        return res.status(500).json({
            success: false,
            message: 'Service JWT secret is not configured',
        });
    }

    // 3) A credential may have been presented but rejected (403 rejected), or
    //    nothing was presented (403 anonymous).

    const hadAnyCredential =
        typeof req.headers[SERVICE_JWT_HEADER] === 'string' ||
        typeof req.headers[LEGACY_SECRET_HEADER] === 'string';
    recordInternalBoundary({
        source: hadAnyCredential ? 'rejected' : 'anonymous',
        outcome: 'reject',
    });
    return res.status(403).json({
        success: false,
        message: 'Direct service access is not allowed',
    });
}

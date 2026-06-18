// src/lib/serviceJwt.js — A-HR-SERVICE-JWT-INBOUND.
//
// Verifies the downstream service JWT minted by the gateway and presented
// on every internal call as `X-Service-Authorization`. Mirrors the
// RBAC reference implementation (erp-rbac-backend/src/lib/serviceJwt.js)
// so the two services accept the same shape of token from the same
// gateway. This is the P2A slice: HMAC verification only (EdDSA /
// refresh-rotation are P2B), but the claim shape, header parsing, and
// fail-closed posture are finalized here so /api can rely on
// req.internalService when the JWT path is taken.
//
// Required env in production:
//   SERVICE_JWT_SECRET   — shared HMAC secret with the gateway.
//   SERVICE_JWT_AUDIENCE — defaults to "internal".
//   SERVICE_JWT_ISSUER   — defaults to "erp-gateway".
//
// In non-production a missing SERVICE_JWT_SECRET makes the verifier
// disabled-but-explicit (returns a "no-secret-configured-nonprod"
// outcome the middleware interprets as "fall through to the legacy
// X-Internal-Secret path"), so local dev without a gateway doesn't
// 500 and HR's existing legacy fallback continues to function.

import jwt from 'jsonwebtoken';

const DEFAULT_AUDIENCE = 'internal';
const DEFAULT_ISSUER = 'erp-gateway';

export const SERVICE_JWT_HEADER = 'x-service-authorization';

// Outcome shape: { ok: boolean, reason?: string, context?: object }
// The middleware decides 401 vs 403 vs fall-through to the legacy secret.

export function extractServiceToken(req) {
    const raw = req.headers[SERVICE_JWT_HEADER];
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Accept "Bearer <jwt>" and bare "<jwt>" (transitional).
    if (/^bearer\s+/i.test(trimmed)) {
        return trimmed.replace(/^bearer\s+/i, '').trim() || null;
    }
    return trimmed;
}

function getSecret() {
    return process.env.SERVICE_JWT_SECRET || '';
}

function getAudience() {
    return process.env.SERVICE_JWT_AUDIENCE || DEFAULT_AUDIENCE;
}

function getIssuer() {
    return process.env.SERVICE_JWT_ISSUER || DEFAULT_ISSUER;
}

// Verify a token string. Returns an outcome object; never throws.
export function verifyServiceToken(token) {
    if (!token) {
        return { ok: false, reason: 'missing-token' };
    }
    const secret = getSecret();
    if (!secret) {
        if (process.env.NODE_ENV === 'production') {
            return { ok: false, reason: 'no-secret-configured' };
        }
        return { ok: false, reason: 'no-secret-configured-nonprod' };
    }
    try {
        const claims = jwt.verify(token, secret, {
            audience: getAudience(),
            issuer: getIssuer(),
            algorithms: ['HS256', 'HS384', 'HS512'],
        });
        return {
            ok: true,
            context: {
                service: claims.sub || claims.service || 'unknown',
                tenantId: claims.tenantId ?? claims.tid ?? null,
                userId: claims.userId ?? claims.uid ?? null,
                // Gateway P2/P3 mints either `email` or `userEmail` —
                // accept both so reconciliation works against whichever
                // claim shape lands first.
                email: claims.email ?? claims.userEmail ?? null,
                claims,
            },
        };
    } catch (err) {
        if (err && err.name === 'TokenExpiredError') {
            return { ok: false, reason: 'expired' };
        }
        return { ok: false, reason: 'invalid' };
    }
}

// Convenience: verify directly from the incoming Express request.
export function verifyServiceRequest(req) {
    const token = extractServiceToken(req);
    return verifyServiceToken(token);
}

// --- Outbound signing (A-HR-EMIT-SERVICE-JWT-DAM) ---
// Mints a short-lived HMAC JWT for HR → peer-service calls so the
// receiving service can verify the caller without relying solely on
// X-Internal-Secret.  Uses the same SERVICE_JWT_SECRET as the
// inbound verifier.

const DEFAULT_SELF_ISSUER = 'erp-hr';
const DEFAULT_EXPIRY = '60s';

export function signServiceJwt(extraClaims = {}) {
    const secret = getSecret();
    if (!secret) return null;

    const selfIssuer =
        process.env.SERVICE_JWT_SELF_ISSUER || DEFAULT_SELF_ISSUER;

    return jwt.sign(
        { sub: selfIssuer, ...extraClaims },
        secret,
        {
            issuer: selfIssuer,
            audience: getAudience(),
            expiresIn: DEFAULT_EXPIRY,
        },
    );
}

// src/lib/serviceJwt.js — A-HR-SERVICE-JWT-INBOUND · X-02 / ARCH-01 §4.1-4.2.
//
// Verifies the downstream service JWT minted by the gateway/rbac and
// presented on every internal call as `X-Service-Authorization`. The two
// real signers now mint EdDSA(Ed25519)-signed tokens carrying a `kid`
// protected-header field:
//   * iss=erp-rbac    kid "rbac-svc-9057db2a"
//   * iss=erp-gateway kid "gw-ed25519-9d4f042d2332f689"
//
// VERIFY ORDER (fail closed if neither path verifies):
//   1. Decode the protected header. If alg=EdDSA, resolve the public key by
//      kid from the registry (src/lib/serviceJwtKeys.js), verify the Ed25519
//      signature with the algorithm PINNED to EdDSA via node:crypto, then
//      enforce iss ∈ {erp-rbac, erp-gateway}, aud="internal", and exp.
//   2. DUAL-ACCEPT (rollout): if the token is HS256/384/512 and the flag
//      SERVICE_JWT_ACCEPT_HS256 is true (default "true" in dev), verify via
//      the legacy shared secret (jsonwebtoken). If the flag is false, REJECT
//      the HS token. The legacy path is NOT removed here (sunset is later).
//
// Rejections: no kid, unknown kid, non-EdDSA alg masquerading as a key it
// isn't, bad signature, expired, wrong iss/aud, HS256-when-disabled.
//
// Required env in production:
//   SERVICE_JWT_SECRET            — legacy shared HMAC secret (HS path).
//   SERVICE_JWT_PUBLIC_KEYS_JSON  — {kid: JWK|PEM} for the EdDSA path.
//   SERVICE_JWT_AUDIENCE          — defaults to "internal".
//   SERVICE_JWT_ISSUER            — legacy single-issuer default "erp-gateway"
//                                   (HS path only; EdDSA accepts the set below).
//   SERVICE_JWT_ACCEPT_HS256      — "true"/"false"; HS dual-accept flag.
//
// In non-production a missing SERVICE_JWT_SECRET makes the HS path
// disabled-but-explicit (returns a "no-secret-configured-nonprod" outcome)
// — but the EdDSA path still functions whenever keys are configured, so the
// gateway/rbac EdDSA plane verifies even with no shared secret present.

import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import { resolvePublicKeyPem } from './serviceJwtKeys.js';
import { mcpCtx } from '../mcp/context.js';

// Source the caller's VERIFIED tenant from the ambient request context (set by
// establishTenantContext for REST and the MCP router) so peer service tokens
// carry a `tid` claim without every call site threading tenantId through. The
// tenant on mcpCtx came from a verified inbound JWT claim, never a spoofable
// header, so re-minting it downstream preserves the isolation guarantee.
// Returns null outside a tenant context (e.g. a boot/job task) → the token is
// simply minted tenant-less and the callee fail-closes as before.
function ambientTenantId() {
    try {
        const t = mcpCtx.getStore()?.user?.tenantId;
        return t != null && String(t).trim() ? String(t) : null;
    } catch {
        return null;
    }
}

// Add an ambient `tid` claim unless the caller explicitly set one (an explicit
// `tid` — including null — opts out, e.g. a genuinely cross-tenant system call).
function withAmbientTenant(extraClaims) {
    if (extraClaims && 'tid' in extraClaims) return extraClaims;
    const tid = ambientTenantId();
    return tid ? { tid, ...extraClaims } : extraClaims;
}

// Header form of the ambient tenant for outbound clients to spread into their
// request headers: defense-in-depth alongside the `tid` claim, and the ONLY
// tenant channel to DAM (whose legacy X-Internal-Secret lane can't verify HR's
// EdDSA token, so it reads the trusted X-Tenant-Id header instead). Empty object
// outside a tenant context so nothing is sent.
export function ambientTenantHeader() {
    const tid = ambientTenantId();
    return tid ? { 'X-Tenant-Id': tid } : {};
}

const DEFAULT_AUDIENCE = 'internal';
const DEFAULT_ISSUER = 'erp-gateway';

// EdDSA tokens may be signed by either real service. The HS legacy path keeps
// its single configurable issuer for backward-compatibility.
const EDDSA_ACCEPTED_ISSUERS = ['erp-rbac', 'erp-gateway'];

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

// HS256 dual-accept flag. Default "true" (dev rollout); any value other than
// an explicit "false" is treated as enabled so a typo fails OPEN only for the
// legacy path that is already gated by the shared secret — set "false" to
// reject HS tokens entirely once the EdDSA cutover completes.
function hs256Accepted() {
    return process.env.SERVICE_JWT_ACCEPT_HS256 !== 'false';
}

// Decode (without verifying) the protected JOSE header so we can branch on alg
// and read the kid. Returns null on any structural problem.
function decodeProtectedHeader(token) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    try {
        const json = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
        const header = JSON.parse(json);
        if (!header || typeof header !== 'object') return null;
        return header;
    } catch {
        return null;
    }
}

// Build the normalized context the middleware attaches to req.internalService.
function buildContext(claims, alg) {
    return {
        service: claims.sub || claims.service || 'unknown',
        tenantId: claims.tenantId ?? claims.tid ?? null,
        userId: claims.userId ?? claims.uid ?? null,
        // Gateway P2/P3 mints either `email` or `userEmail` — accept both so
        // reconciliation works against whichever claim shape lands first.
        email: claims.email ?? claims.userEmail ?? null,
        alg,
        claims,
    };
}

// Verify an EdDSA(Ed25519) service-JWT entirely with node:crypto, with the
// algorithm PINNED to Ed25519 (the kid resolves to an Ed25519 public key and
// we never feed attacker-chosen alg into a verify primitive — this defeats
// alg-confusion). Returns an outcome object; never throws.
function verifyEdDSA(token, header) {
    if (!header.kid) {
        return { ok: false, reason: 'no-kid' };
    }
    const pem = resolvePublicKeyPem(header.kid);
    if (!pem) {
        return { ok: false, reason: 'unknown-kid' };
    }

    const parts = token.split('.');
    if (parts.length !== 3 || !parts[2]) {
        return { ok: false, reason: 'invalid' };
    }
    const [encHeader, encPayload, encSig] = parts;

    let keyObject;
    try {
        keyObject = crypto.createPublicKey(pem);
    } catch {
        return { ok: false, reason: 'unknown-kid' };
    }
    // Defense in depth: the registry only admits Ed25519, but re-check here so
    // a future registry change can never route a non-Ed25519 key into this
    // signature check.
    if (keyObject.asymmetricKeyType !== 'ed25519') {
        return { ok: false, reason: 'invalid' };
    }

    let signatureValid;
    try {
        const signature = Buffer.from(encSig, 'base64url');
        // algorithm pinned to Ed25519: crypto.verify(null, ...) for an
        // Ed25519 key uses EdDSA only — header.alg is NEVER consulted here.
        signatureValid = crypto.verify(
            null,
            Buffer.from(`${encHeader}.${encPayload}`),
            keyObject,
            signature
        );
    } catch {
        signatureValid = false;
    }
    if (!signatureValid) {
        return { ok: false, reason: 'invalid' };
    }

    let claims;
    try {
        claims = JSON.parse(Buffer.from(encPayload, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'invalid' };
    }
    if (!claims || typeof claims !== 'object') {
        return { ok: false, reason: 'invalid' };
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === 'number' && now >= claims.exp) {
        return { ok: false, reason: 'expired' };
    }
    if (typeof claims.nbf === 'number' && now < claims.nbf) {
        return { ok: false, reason: 'invalid' };
    }
    if (!EDDSA_ACCEPTED_ISSUERS.includes(claims.iss)) {
        return { ok: false, reason: 'invalid' };
    }
    const expectedAud = getAudience();
    const aud = claims.aud;
    const audOk = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
    if (!audOk) {
        return { ok: false, reason: 'invalid' };
    }

    return { ok: true, context: buildContext(claims, 'EdDSA') };
}

// Verify a legacy HS256/384/512 token via the shared secret (jsonwebtoken),
// gated behind the dual-accept flag.
function verifyHS(token) {
    if (!hs256Accepted()) {
        return { ok: false, reason: 'hs256-disabled' };
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
        return { ok: true, context: buildContext(claims, claims.alg || 'HS256') };
    } catch (err) {
        if (err && err.name === 'TokenExpiredError') {
            return { ok: false, reason: 'expired' };
        }
        return { ok: false, reason: 'invalid' };
    }
}

// Verify a token string. Returns an outcome object; never throws.
// Prefers EdDSA (the new signer plane); falls back to HS dual-accept.
export function verifyServiceToken(token) {
    if (!token) {
        return { ok: false, reason: 'missing-token' };
    }

    const header = decodeProtectedHeader(token);
    if (!header || !header.alg) {
        return { ok: false, reason: 'invalid' };
    }

    if (header.alg === 'EdDSA') {
        return verifyEdDSA(token, header);
    }

    if (header.alg === 'HS256' || header.alg === 'HS384' || header.alg === 'HS512') {
        // Re-derive the HMAC alg from the protected header rather than trusting
        // the verified claim, so the context.alg reflects the wire alg.
        const outcome = verifyHS(token);
        if (outcome.ok && outcome.context) {
            outcome.context.alg = header.alg;
        }
        return outcome;
    }

    // Any other alg (none, RS*, ES*, …) is not part of the accepted plane.
    return { ok: false, reason: 'invalid' };
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

// Cache the imported Ed25519 private key (env-sourced) for the process lifetime.
let _svcPrivKey = null;
let _svcPrivKeyPem = null;
function getServicePrivateKey() {
    const pem = process.env.SERVICE_JWT_PRIVATE_KEY_PEM;
    if (!pem) return null;
    if (_svcPrivKey && _svcPrivKeyPem === pem) return _svcPrivKey;
    try {
        _svcPrivKey = crypto.createPrivateKey(pem); // PKCS#8 Ed25519
        _svcPrivKeyPem = pem;
        return _svcPrivKey;
    } catch {
        return null;
    }
}

const b64url = (x) => Buffer.from(x).toString('base64url');

// HS256 service token (unchanged legacy default). Peers that use the legacy
// X-Internal-Secret lane or the HS256 dual-accept path (e.g. DAM) keep working
// exactly as before — this function is intentionally left as HS256 so switching
// HR's outbound scheme never regresses an existing peer.
export function signServiceJwt(extraClaims = {}) {
    const secret = getSecret();
    if (!secret) return null;

    const selfIssuer =
        process.env.SERVICE_JWT_SELF_ISSUER || DEFAULT_SELF_ISSUER;

    return jwt.sign(
        { sub: selfIssuer, ...withAmbientTenant(extraClaims) },
        secret,
        {
            issuer: selfIssuer,
            audience: getAudience(),
            expiresIn: DEFAULT_EXPIRY,
        },
    );
}

// EdDSA(Ed25519) service token for peers on the EdDSA plane (RBAC, PM). Hand-
// rolled with node:crypto (jsonwebtoken has no EdDSA support); carries `kid` so
// verifiers resolve HR's public key from their SERVICE_JWT_PUBLIC_KEYS_JSON
// registry — no shared secret. Returns null when the private key / kid are not
// configured, so callers fail-soft. Used ONLY by the RBAC/PM clients, so HR's
// other peers (DAM) are unaffected.
export function signServiceJwtEdDSA(extraClaims = {}) {
    const privKey = getServicePrivateKey();
    const kid = process.env.SERVICE_JWT_CURRENT_KID;
    if (!privKey || !kid) return null;

    const selfIssuer = process.env.SERVICE_JWT_SELF_ISSUER || DEFAULT_SELF_ISSUER;
    const nowSec = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
    const payload = b64url(
        JSON.stringify({
            ...withAmbientTenant(extraClaims),
            sub: selfIssuer,
            iss: selfIssuer,
            aud: getAudience(),
            iat: nowSec,
            exp: nowSec + 60,
        })
    );
    const input = `${header}.${payload}`;
    try {
        // Ed25519: algorithm MUST be null — node uses the key's built-in curve.
        const sig = crypto.sign(null, Buffer.from(input), privKey);
        return `${input}.${b64url(sig)}`;
    } catch {
        return null;
    }
}

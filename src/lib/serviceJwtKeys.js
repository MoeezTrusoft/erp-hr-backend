// src/lib/serviceJwtKeys.js — A-HR · X-02 / ARCH-01 §4.1-4.2.
//
// Public-key registry for inbound EdDSA(Ed25519) service-JWT verification.
// Inbound service-JWTs from the two real signers (iss=erp-rbac via
// kid "rbac-svc-9057db2a", iss=erp-gateway via kid "gw-ed25519-...") carry a
// `kid` protected-header field; this module resolves that kid to an SPKI PEM
// public key so the verifier can check the Ed25519 signature.
//
// Source of truth is the env var SERVICE_JWT_PUBLIC_KEYS_JSON, a JSON object
// keyed by kid. Each value may be EITHER:
//   * a JWK object   {"kty":"OKP","crv":"Ed25519","x":"<base64url>"}  — or
//   * an SPKI PEM string ("-----BEGIN PUBLIC KEY-----\n...").
// Both are normalized to SPKI PEM at load time via node:crypto. JWK is the
// shape published by the signers' /.well-known/jwks.json; PEM is convenient
// for hand-authored .env entries.
//
// The registry is parsed once and memoized. Tests (and a future JWKS-rotation
// refresh) can force a re-parse with loadPublicKeyRegistry({ reload: true }).
//
// SECURITY: only Ed25519 (OKP) keys are admitted. A registry entry that is
// not a valid Ed25519 public key is skipped (logged at warn, never throws)
// so one malformed entry cannot disable the whole verifier. No key material
// is ever logged — only kids and counts.

import crypto from 'node:crypto';

import logger from './logger.js';

let cache = null;
let cacheSourceSnapshot = null;

// Normalize one registry value (JWK object OR PEM string) to an SPKI PEM.
// Returns null (and logs) if the value is not a usable Ed25519 public key.
function toPublicKeyPem(kid, value) {
    try {
        let keyObject;
        if (value && typeof value === 'object') {
            // Treat as a JWK.
            keyObject = crypto.createPublicKey({ key: value, format: 'jwk' });
        } else if (typeof value === 'string' && value.includes('BEGIN')) {
            keyObject = crypto.createPublicKey(value);
        } else if (typeof value === 'string') {
            // A bare base64url x-coordinate is ambiguous; require a JWK/PEM.
            logger.warn({ kid }, 'service-jwt key registry: unrecognized key encoding, skipped');
            return null;
        } else {
            logger.warn({ kid }, 'service-jwt key registry: empty/invalid entry, skipped');
            return null;
        }
        if (keyObject.asymmetricKeyType !== 'ed25519') {
            logger.warn(
                { kid, keyType: keyObject.asymmetricKeyType },
                'service-jwt key registry: non-Ed25519 key rejected'
            );
            return null;
        }
        return keyObject.export({ type: 'spki', format: 'pem' });
    } catch (err) {
        logger.warn(
            { kid, err: err && err.message },
            'service-jwt key registry: failed to load entry'
        );
        return null;
    }
}

function parseRegistrySource() {
    const raw = process.env.SERVICE_JWT_PUBLIC_KEYS_JSON;
    if (!raw || !raw.trim()) return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        logger.warn(
            { err: err && err.message },
            'service-jwt key registry: SERVICE_JWT_PUBLIC_KEYS_JSON is not valid JSON; no EdDSA keys loaded'
        );
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn(
            'service-jwt key registry: SERVICE_JWT_PUBLIC_KEYS_JSON must be a JSON object keyed by kid'
        );
        return {};
    }
    const out = {};
    for (const [kid, value] of Object.entries(parsed)) {
        const pem = toPublicKeyPem(kid, value);
        if (pem) out[kid] = pem;
    }
    return out;
}

// Build (or rebuild) the {kid -> SPKI PEM} registry. Memoized against the
// current SERVICE_JWT_PUBLIC_KEYS_JSON value so env changes between requests
// (notably in tests) take effect without a manual reload, while steady-state
// runtime reuses the parsed result.
export function loadPublicKeyRegistry({ reload = false } = {}) {
    const source = process.env.SERVICE_JWT_PUBLIC_KEYS_JSON || '';
    if (!reload && cache && cacheSourceSnapshot === source) {
        return cache;
    }
    cache = parseRegistrySource();
    cacheSourceSnapshot = source;
    return cache;
}

// Resolve a kid to its SPKI PEM, or null if unknown.
export function resolvePublicKeyPem(kid) {
    if (!kid || typeof kid !== 'string') return null;
    const reg = loadPublicKeyRegistry();
    return reg[kid] || null;
}

// Convenience for diagnostics/tests: the set of known kids (never the keys).
export function knownKids() {
    return Object.keys(loadPublicKeyRegistry());
}

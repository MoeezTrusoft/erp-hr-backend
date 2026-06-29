// tests/unit/lib/serviceJwt.eddsa.test.js — A-HR · X-02 / ARCH-01 §4.1-4.2.
//
// Inbound service-JWT verification upgrade: accept EdDSA(Ed25519) tokens
// minted by the two real signers (iss=erp-rbac, iss=erp-gateway) resolving
// the public key by `kid` from a registry, while KEEPING the legacy HS256
// path behind the SERVICE_JWT_ACCEPT_HS256 flag (dual-accept rollout).
//
// HERMETIC: every EdDSA case generates an EPHEMERAL Ed25519 keypair in the
// test, injects its public key into the registry under a test kid, signs a
// service-JWT with the private key (alg=EdDSA, kid header), and asserts the
// verify path ACCEPTS it. No real private key is ever needed; the two REAL
// signer *public* keys are only asserted to be PRESENT in the registry/.env.
//
// jsonwebtoken@9 cannot SIGN EdDSA, so the test mints EdDSA JWTs with
// node:crypto directly (sign(null, input, ed25519PrivateKey)) — the exact
// wire shape the gateway/rbac signers produce.
import {
    describe, test, expect, beforeEach, afterAll,
} from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

import {
    verifyServiceToken,
} from '../../../src/lib/serviceJwt.js';
import {
    resolvePublicKeyPem,
    loadPublicKeyRegistry,
} from '../../../src/lib/serviceJwtKeys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const FIXED_SECRET = 'test-service-secret-do-not-use-in-prod';

const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    SERVICE_JWT_SECRET: process.env.SERVICE_JWT_SECRET,
    SERVICE_JWT_AUDIENCE: process.env.SERVICE_JWT_AUDIENCE,
    SERVICE_JWT_ISSUER: process.env.SERVICE_JWT_ISSUER,
    SERVICE_JWT_ACCEPT_HS256: process.env.SERVICE_JWT_ACCEPT_HS256,
    SERVICE_JWT_PUBLIC_KEYS_JSON: process.env.SERVICE_JWT_PUBLIC_KEYS_JSON,
};

const TEST_KID = 'test-ephemeral-kid';

function b64url(input) {
    return Buffer.from(input).toString('base64url');
}

// Mint an EdDSA service-JWT exactly as the rbac/gateway signers do:
// protected header {alg:"EdDSA", typ:"JWT", kid}, then Ed25519 signature
// over `${b64(header)}.${b64(payload)}`.
function mintEdToken(privateKey, {
    kid = TEST_KID,
    omitKid = false,
    iss = 'erp-rbac',
    aud = 'internal',
    expSeconds = 300,
    iat,
    extra = {},
} = {}) {
    const header = omitKid
        ? { alg: 'EdDSA', typ: 'JWT' }
        : { alg: 'EdDSA', typ: 'JWT', kid };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss,
        aud,
        iat: iat ?? now,
        exp: now + expSeconds,
        sub: 'erp-gateway',
        tenantId: 't-uuid-1',
        userId: 42,
        ...extra,
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.sign(null, Buffer.from(signingInput), privateKey);
    return `${signingInput}.${b64url(sig)}`;
}

// Register an ephemeral keypair under TEST_KID and return the private key.
function registerEphemeralKey(kid = TEST_KID) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const reg = JSON.parse(process.env.SERVICE_JWT_PUBLIC_KEYS_JSON || '{}');
    reg[kid] = pem;
    process.env.SERVICE_JWT_PUBLIC_KEYS_JSON = JSON.stringify(reg);
    loadPublicKeyRegistry({ reload: true });
    return privateKey;
}

describe('serviceJwt EdDSA verification (X-02)', () => {
    beforeEach(() => {
        process.env.NODE_ENV = 'test';
        process.env.SERVICE_JWT_SECRET = FIXED_SECRET;
        process.env.SERVICE_JWT_AUDIENCE = 'internal';
        process.env.SERVICE_JWT_ISSUER = 'erp-gateway';
        process.env.SERVICE_JWT_ACCEPT_HS256 = 'true';
        // Start each test from an empty registry so the test controls kids.
        process.env.SERVICE_JWT_PUBLIC_KEYS_JSON = '{}';
        loadPublicKeyRegistry({ reload: true });
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(ORIGINAL)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        loadPublicKeyRegistry({ reload: true });
    });

    describe('EdDSA accept path (hermetic ephemeral key)', () => {
        test('accepts an EdDSA token (iss=erp-rbac) resolved by kid', () => {
            const priv = registerEphemeralKey();
            const token = mintEdToken(priv, { iss: 'erp-rbac' });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(true);
            expect(outcome.context.alg).toBe('EdDSA');
            expect(outcome.context.claims.iss).toBe('erp-rbac');
            expect(outcome.context.tenantId).toBe('t-uuid-1');
            expect(outcome.context.userId).toBe(42);
        });

        test('accepts an EdDSA token (iss=erp-gateway)', () => {
            const priv = registerEphemeralKey();
            const token = mintEdToken(priv, { iss: 'erp-gateway' });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(true);
            expect(outcome.context.alg).toBe('EdDSA');
        });
    });

    describe('EdDSA reject paths', () => {
        test('rejects an EdDSA token with no kid header', () => {
            const priv = registerEphemeralKey();
            const token = mintEdToken(priv, { omitKid: true });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('no-kid');
        });

        test('rejects an EdDSA token whose kid is unknown to the registry', () => {
            registerEphemeralKey(); // registers TEST_KID
            const { privateKey } = crypto.generateKeyPairSync('ed25519');
            const token = mintEdToken(privateKey, { kid: 'kid-not-registered' });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('unknown-kid');
        });

        test('rejects when the signature does not match the kid public key', () => {
            registerEphemeralKey(); // TEST_KID -> key A
            const { privateKey: keyB } = crypto.generateKeyPairSync('ed25519');
            // Sign with key B but claim TEST_KID (resolves to key A) → bad sig.
            const token = mintEdToken(keyB, { kid: TEST_KID });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('invalid');
        });

        test('rejects an expired EdDSA token', () => {
            const priv = registerEphemeralKey();
            const token = mintEdToken(priv, { expSeconds: -10 });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('expired');
        });

        test('rejects a wrong issuer', () => {
            const priv = registerEphemeralKey();
            const token = mintEdToken(priv, { iss: 'evil-issuer' });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('invalid');
        });

        test('rejects a wrong audience', () => {
            const priv = registerEphemeralKey();
            const token = mintEdToken(priv, { aud: 'public' });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('invalid');
        });

        test('rejects alg-confusion: HS256 header bearing a known EdDSA kid', () => {
            registerEphemeralKey();
            const pem = resolvePublicKeyPem(TEST_KID);
            // Forge an HS256 token whose HMAC key is the public PEM and whose
            // header claims the EdDSA kid. The EdDSA verify path must reject it
            // because the alg is pinned to EdDSA (classic alg-confusion attack).
            const forged = jwt.sign(
                { foo: 'evil' },
                pem,
                { algorithm: 'HS256', keyid: TEST_KID, audience: 'internal', issuer: 'erp-rbac' },
            );
            const outcome = verifyServiceToken(forged);
            // HS256 path is on (flag true) but the shared secret is FIXED_SECRET,
            // not the PEM → it must fail to verify and be rejected, NOT accepted
            // via the EdDSA key material.
            expect(outcome.ok).toBe(false);
        });

        test('rejects alg=none', () => {
            registerEphemeralKey();
            const header = { alg: 'none', typ: 'JWT', kid: TEST_KID };
            const payload = { iss: 'erp-rbac', aud: 'internal' };
            const token = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.`;
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(false);
        });
    });

    describe('HS256 dual-accept flag', () => {
        function mintHs(opts = {}) {
            const {
                secret = FIXED_SECRET,
                issuer = 'erp-gateway',
                audience = 'internal',
            } = opts;
            return jwt.sign(
                { sub: 'erp-gateway', tenantId: 't-1', userId: 7 },
                secret,
                { issuer, audience, expiresIn: '5m' },
            );
        }

        test('HS256 token is ACCEPTED when SERVICE_JWT_ACCEPT_HS256=true', () => {
            process.env.SERVICE_JWT_ACCEPT_HS256 = 'true';
            const outcome = verifyServiceToken(mintHs());
            expect(outcome.ok).toBe(true);
            expect(outcome.context.alg).toMatch(/^HS/);
        });

        test('HS256 token is REJECTED when SERVICE_JWT_ACCEPT_HS256=false', () => {
            process.env.SERVICE_JWT_ACCEPT_HS256 = 'false';
            const outcome = verifyServiceToken(mintHs());
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('hs256-disabled');
        });

        test('EdDSA is still accepted even when HS256 is disabled', () => {
            process.env.SERVICE_JWT_ACCEPT_HS256 = 'false';
            const priv = registerEphemeralKey();
            const outcome = verifyServiceToken(mintEdToken(priv));
            expect(outcome.ok).toBe(true);
            expect(outcome.context.alg).toBe('EdDSA');
        });
    });

    describe('real signer kids are present in .env', () => {
        test('.env registers BOTH real signer kids in SERVICE_JWT_PUBLIC_KEYS_JSON', () => {
            const envText = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
            const line = envText
                .split('\n')
                .find((l) => l.startsWith('SERVICE_JWT_PUBLIC_KEYS_JSON='));
            expect(line).toBeDefined();
            const json = line.slice('SERVICE_JWT_PUBLIC_KEYS_JSON='.length);
            const reg = JSON.parse(json);
            expect(Object.keys(reg)).toEqual(
                expect.arrayContaining([
                    'rbac-svc-9057db2a',
                    'gw-ed25519-9d4f042d2332f689',
                ]),
            );
        });

        test('each real signer entry resolves to a usable Ed25519 public key', () => {
            const envText = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
            const line = envText
                .split('\n')
                .find((l) => l.startsWith('SERVICE_JWT_PUBLIC_KEYS_JSON='));
            const reg = JSON.parse(line.slice('SERVICE_JWT_PUBLIC_KEYS_JSON='.length));
            for (const kid of ['rbac-svc-9057db2a', 'gw-ed25519-9d4f042d2332f689']) {
                process.env.SERVICE_JWT_PUBLIC_KEYS_JSON = JSON.stringify(reg);
                loadPublicKeyRegistry({ reload: true });
                const pem = resolvePublicKeyPem(kid);
                expect(pem).toBeTruthy();
                const keyObj = crypto.createPublicKey(pem);
                expect(keyObj.asymmetricKeyType).toBe('ed25519');
            }
        });
    });
});

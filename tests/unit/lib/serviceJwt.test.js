// tests/unit/lib/serviceJwt.test.js — A-HR-SERVICE-JWT-INBOUND.
//
// Unit-tests for the service-JWT verifier. Mirrors the RBAC reference
// behaviour: the verifier never throws and produces a small allowlist
// of `reason` codes that the middleware can pattern-match on. The
// claim shape (service / tenantId / userId / email) is asserted so
// that downstream context attachment stays stable.
import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import jwt from 'jsonwebtoken';

import {
    SERVICE_JWT_HEADER,
    extractServiceToken,
    verifyServiceToken,
    verifyServiceRequest,
    signServiceJwt,
} from '../../../src/lib/serviceJwt.js';

const FIXED_SECRET = 'test-service-secret-do-not-use-in-prod';

const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    SERVICE_JWT_SECRET: process.env.SERVICE_JWT_SECRET,
    SERVICE_JWT_AUDIENCE: process.env.SERVICE_JWT_AUDIENCE,
    SERVICE_JWT_ISSUER: process.env.SERVICE_JWT_ISSUER,
};

function mintToken(overrides = {}, options = {}) {
    const {
        secret = FIXED_SECRET,
        issuer = process.env.SERVICE_JWT_ISSUER,
        audience = process.env.SERVICE_JWT_AUDIENCE,
        expiresIn = '5m',
    } = options;
    return jwt.sign(
        { sub: 'erp-gateway', tenantId: 't-1', userId: 42, ...overrides },
        secret,
        { issuer, audience, expiresIn }
    );
}

describe('src/lib/serviceJwt.js', () => {
    beforeEach(() => {
        process.env.NODE_ENV = 'test';
        process.env.SERVICE_JWT_SECRET = FIXED_SECRET;
        process.env.SERVICE_JWT_AUDIENCE = 'internal';
        process.env.SERVICE_JWT_ISSUER = 'erp-gateway';
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(ORIGINAL)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    describe('SERVICE_JWT_HEADER', () => {
        test('is the lower-cased x-service-authorization header', () => {
            expect(SERVICE_JWT_HEADER).toBe('x-service-authorization');
        });
    });

    describe('extractServiceToken', () => {
        test('returns null when the header is absent', () => {
            expect(extractServiceToken({ headers: {} })).toBeNull();
        });

        test('returns null when the header is blank', () => {
            expect(extractServiceToken({
                headers: { [SERVICE_JWT_HEADER]: '   ' },
            })).toBeNull();
        });

        test('strips the "Bearer " prefix case-insensitively', () => {
            expect(extractServiceToken({
                headers: { [SERVICE_JWT_HEADER]: 'Bearer abc.def.ghi' },
            })).toBe('abc.def.ghi');
            expect(extractServiceToken({
                headers: { [SERVICE_JWT_HEADER]: 'bearer abc.def.ghi' },
            })).toBe('abc.def.ghi');
            expect(extractServiceToken({
                headers: { [SERVICE_JWT_HEADER]: 'BEARER abc.def.ghi' },
            })).toBe('abc.def.ghi');
        });

        test('accepts bare tokens without a Bearer prefix (transitional)', () => {
            expect(extractServiceToken({
                headers: { [SERVICE_JWT_HEADER]: 'abc.def.ghi' },
            })).toBe('abc.def.ghi');
        });
    });

    describe('verifyServiceToken', () => {
        test('accepts a valid token signed with SERVICE_JWT_SECRET', () => {
            const token = mintToken({ email: 'svc@trusoft.test', userId: 7 });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(true);
            expect(outcome.context.service).toBe('erp-gateway');
            expect(outcome.context.userId).toBe(7);
            expect(outcome.context.tenantId).toBe('t-1');
            expect(outcome.context.email).toBe('svc@trusoft.test');
            expect(outcome.context.claims).toBeDefined();
        });

        test('falls back to claims.tid / claims.uid / claims.userEmail aliases', () => {
            const token = mintToken({
                tenantId: undefined,
                userId: undefined,
                tid: 99,
                uid: 123,
                userEmail: 'alias@trusoft.test',
            });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(true);
            expect(outcome.context.tenantId).toBe(99);
            expect(outcome.context.userId).toBe(123);
            expect(outcome.context.email).toBe('alias@trusoft.test');
        });

        test('rejects a tampered token with reason "invalid"', () => {
            const token = mintToken();
            const tampered = `${token}x`;
            const outcome = verifyServiceToken(tampered);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('invalid');
        });

        test('rejects a token signed by a different secret with reason "invalid"', () => {
            const token = mintToken({}, { secret: 'a-completely-different-secret' });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('invalid');
        });

        test('rejects a token with the wrong audience as "invalid"', () => {
            const token = mintToken({}, { audience: 'not-internal' });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('invalid');
        });

        test('rejects an expired token with reason "expired"', () => {
            const token = mintToken({}, { expiresIn: '-1s' });
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('expired');
        });

        test('rejects empty / null token with reason "missing-token"', () => {
            expect(verifyServiceToken('').reason).toBe('missing-token');
            expect(verifyServiceToken(null).reason).toBe('missing-token');
            expect(verifyServiceToken(undefined).reason).toBe('missing-token');
        });

        test('returns "no-secret-configured" in production when SERVICE_JWT_SECRET is unset', () => {
            process.env.NODE_ENV = 'production';
            delete process.env.SERVICE_JWT_SECRET;
            const outcome = verifyServiceToken('any.value.here');
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('no-secret-configured');
        });

        test('returns "no-secret-configured-nonprod" outside production when SERVICE_JWT_SECRET is unset', () => {
            process.env.NODE_ENV = 'test';
            delete process.env.SERVICE_JWT_SECRET;
            const outcome = verifyServiceToken('any.value.here');
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('no-secret-configured-nonprod');
        });
    });

    describe('verifyServiceRequest', () => {
        test('delegates to verifyServiceToken using the request header', () => {
            const token = mintToken({ userId: 5 });
            const req = { headers: { [SERVICE_JWT_HEADER]: `Bearer ${token}` } };
            const outcome = verifyServiceRequest(req);
            expect(outcome.ok).toBe(true);
            expect(outcome.context.userId).toBe(5);
        });

        test('returns "missing-token" when no header is present', () => {
            const outcome = verifyServiceRequest({ headers: {} });
            expect(outcome.ok).toBe(false);
            expect(outcome.reason).toBe('missing-token');
        });
    });

    // --- A-HR-EMIT-SERVICE-JWT-DAM: outbound signing ---
    describe('signServiceJwt', () => {
        test('returns a JWT string when SERVICE_JWT_SECRET is set', () => {
            const token = signServiceJwt();
            expect(typeof token).toBe('string');
            expect(token.split('.')).toHaveLength(3);
        });

        test('token verifies with the same secret/audience', () => {
            const token = signServiceJwt();
            const decoded = jwt.verify(token, FIXED_SECRET, {
                audience: 'internal',
                algorithms: ['HS256', 'HS384', 'HS512'],
            });
            expect(decoded.sub).toBe('erp-hr');
            expect(decoded.iss).toBe('erp-hr');
            expect(decoded.aud).toBe('internal');
        });

        test('extra claims are included in the token payload', () => {
            const token = signServiceJwt({ tenantId: 't-99', userId: 42 });
            const decoded = jwt.verify(token, FIXED_SECRET, {
                audience: 'internal',
                algorithms: ['HS256', 'HS384', 'HS512'],
            });
            expect(decoded.tenantId).toBe('t-99');
            expect(decoded.userId).toBe(42);
        });

        test('respects SERVICE_JWT_SELF_ISSUER env override', () => {
            process.env.SERVICE_JWT_SELF_ISSUER = 'erp-custom';
            const token = signServiceJwt();
            const decoded = jwt.verify(token, FIXED_SECRET, {
                audience: 'internal',
                issuer: 'erp-custom',
                algorithms: ['HS256', 'HS384', 'HS512'],
            });
            expect(decoded.sub).toBe('erp-custom');
            expect(decoded.iss).toBe('erp-custom');
            delete process.env.SERVICE_JWT_SELF_ISSUER;
        });

        test('returns null when SERVICE_JWT_SECRET is unset', () => {
            delete process.env.SERVICE_JWT_SECRET;
            expect(signServiceJwt()).toBeNull();
        });

        test('minted token is accepted by the inbound verifier', () => {
            // Round-trip: sign → verify (simulates HR → DAM → DAM-verifier).
            // Both sides share the same secret/audience, so the inbound
            // verifier with matching audience should accept.
            process.env.SERVICE_JWT_ISSUER = 'erp-hr';
            const token = signServiceJwt();
            const outcome = verifyServiceToken(token);
            expect(outcome.ok).toBe(true);
            expect(outcome.context.service).toBe('erp-hr');
        });
    });
});

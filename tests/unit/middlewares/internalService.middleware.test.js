// tests/unit/middlewares/internalService.middleware.test.js
// A-HR-SERVICE-JWT-INBOUND.
//
// End-to-end behavioural test for the /api boundary guard, driven
// through createApp() with supertest. Asserts the three accept paths
// and the rejection shapes:
//
//   * valid service JWT (X-Service-Authorization)         → accept
//   * legacy X-Internal-Secret (preserved fallback)       → accept
//   * neither presented                                   → 403
//   * JWT present but tampered / expired / wrong secret   → 401
//   * JWT present AND legacy present, JWT invalid         → 401 (no
//     silent downgrade — protects against a stolen JWT being rescued
//     by an attacker who also happens to know the legacy secret)
//   * neither secret configured on the process            → 500
//     (preserves the pre-existing HR contract surfaced by
//     tests/unit/app.export.test.js)
//
// Also asserts the auth_internal_boundary_total Prometheus counter is
// emitted with the expected (source, outcome) labels for the jwt /
// legacy / rejected / anonymous paths, and is materialised by the
// public /metrics endpoint.
import { jest, describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
    default: {
        $connect: jest.fn().mockResolvedValue(undefined),
        $disconnect: jest.fn().mockResolvedValue(undefined),
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    },
}));

const { createApp } = await import('../../../src/app.js');
const { _resetAuthMetricsForTests } = await import(
    '../../../src/lib/authMetrics.js'
);

const FIXED_JWT_SECRET = 'test-service-secret-do-not-use-in-prod';
const FIXED_LEGACY_SECRET = 'test-internal-secret';

const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET,
    SERVICE_JWT_SECRET: process.env.SERVICE_JWT_SECRET,
    SERVICE_JWT_AUDIENCE: process.env.SERVICE_JWT_AUDIENCE,
    SERVICE_JWT_ISSUER: process.env.SERVICE_JWT_ISSUER,
};

function mintToken(overrides = {}, options = {}) {
    const {
        secret = FIXED_JWT_SECRET,
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

function readMetricSample(text, source, outcome) {
    const re = new RegExp(
        `^auth_internal_boundary_total\\{[^}]*source="${source}"[^}]*outcome="${outcome}"[^}]*\\}\\s+(\\d+(?:\\.\\d+)?)$`,
        'm'
    );
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
}

describe('internalServiceGuard — /api boundary', () => {
    beforeEach(() => {
        process.env.NODE_ENV = 'test';
        process.env.INTERNAL_SERVICE_SECRET = FIXED_LEGACY_SECRET;
        process.env.SERVICE_JWT_SECRET = FIXED_JWT_SECRET;
        process.env.SERVICE_JWT_AUDIENCE = 'internal';
        process.env.SERVICE_JWT_ISSUER = 'erp-gateway';
        _resetAuthMetricsForTests();
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(ORIGINAL)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        _resetAuthMetricsForTests();
    });

    describe('accept: valid service JWT', () => {
        test('Bearer JWT is accepted (falls through to 404 because the path is not mounted)', async () => {
            const token = mintToken();
            const response = await request(createApp())
                .get('/api/this-path-does-not-need-to-exist')
                .set('x-service-authorization', `Bearer ${token}`);

            expect(response.status).not.toBe(401);
            expect(response.status).not.toBe(403);
            expect(response.status).not.toBe(500);
            expect(response.status).toBe(404);
        });

        test('bare JWT (no "Bearer ") is also accepted', async () => {
            const token = mintToken();
            const response = await request(createApp())
                .get('/api/anything')
                .set('x-service-authorization', token);

            expect(response.status).toBe(404);
        });
    });

    describe('reject: invalid service JWT', () => {
        test('tampered JWT returns 401 "Invalid service token"', async () => {
            const tampered = `${mintToken()}x`;
            const response = await request(createApp())
                .get('/api/anything')
                .set('x-service-authorization', `Bearer ${tampered}`);

            expect(response.status).toBe(401);
            expect(response.body.success).toBe(false);
            expect(response.body.message).toMatch(/invalid service token/i);
        });

        test('expired JWT returns 401 even when a valid legacy secret is ALSO presented', async () => {
            // No silent downgrade: a JWT that fails verification is
            // rejected outright, even if the caller knows the legacy
            // secret. Otherwise a stolen-and-revoked JWT plus a leaked
            // legacy secret would be re-accepted as legitimate.
            const expired = mintToken({}, { expiresIn: '-1s' });
            const response = await request(createApp())
                .get('/api/anything')
                .set('x-service-authorization', `Bearer ${expired}`)
                .set('x-internal-secret', FIXED_LEGACY_SECRET);

            expect(response.status).toBe(401);
            expect(response.body.message).toMatch(/invalid service token/i);
        });

        test('JWT signed by a different secret returns 401', async () => {
            const wrongSecret = mintToken({}, { secret: 'a-different-secret' });
            const response = await request(createApp())
                .get('/api/anything')
                .set('x-service-authorization', `Bearer ${wrongSecret}`);

            expect(response.status).toBe(401);
        });
    });

    describe('accept: legacy X-Internal-Secret fallback is preserved', () => {
        test('matching legacy secret falls through to 404 (gate passed)', async () => {
            const response = await request(createApp())
                .get('/api/this-path-does-not-need-to-exist')
                .set('x-internal-secret', FIXED_LEGACY_SECRET);

            expect(response.status).toBe(404);
            expect(response.status).not.toBe(403);
        });

        test('matching legacy secret still works when SERVICE_JWT_SECRET is unset', async () => {
            delete process.env.SERVICE_JWT_SECRET;

            const response = await request(createApp())
                .get('/api/anything')
                .set('x-internal-secret', FIXED_LEGACY_SECRET);

            expect(response.status).toBe(404);
        });
    });

    describe('reject: missing or wrong credentials', () => {
        test('no credentials → 403 anonymous', async () => {
            const response = await request(createApp()).get('/api/anything');

            expect(response.status).toBe(403);
            expect(response.body.success).toBe(false);
            expect(response.body.message).toMatch(/direct service access/i);
        });

        test('wrong legacy secret → 403 rejected', async () => {
            const response = await request(createApp())
                .get('/api/anything')
                .set('x-internal-secret', 'wrong-secret');

            expect(response.status).toBe(403);
            expect(response.body.success).toBe(false);
        });

        test('both INTERNAL_SERVICE_SECRET and SERVICE_JWT_SECRET unset → 500 (preserves HR pre-existing contract)', async () => {
            delete process.env.INTERNAL_SERVICE_SECRET;
            delete process.env.SERVICE_JWT_SECRET;

            const response = await request(createApp()).get('/api/anything');

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
            expect(response.body.message).toMatch(/not configured/i);
        });
    });

    describe('public endpoints stay unguarded', () => {
        test('/healthz is not affected by the guard', async () => {
            const response = await request(createApp()).get('/healthz');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('ok');
        });
    });

    describe('auth_internal_boundary_total metric', () => {
        test('increments source=service-jwt,outcome=accept on a valid JWT', async () => {
            const token = mintToken();
            const app = createApp();
            await request(app)
                .get('/api/anything')
                .set('x-service-authorization', `Bearer ${token}`);

            const metricsBody = await request(app).get('/metrics');
            expect(metricsBody.status).toBe(200);
            expect(
                readMetricSample(metricsBody.text, 'service-jwt', 'accept')
            ).toBeGreaterThanOrEqual(1);
            expect(
                readMetricSample(metricsBody.text, 'legacy-secret', 'accept')
            ).toBe(0);
            expect(
                readMetricSample(metricsBody.text, 'rejected', 'reject')
            ).toBe(0);
        });

        test('increments source=legacy-secret,outcome=accept on a valid legacy secret', async () => {
            const app = createApp();
            await request(app)
                .get('/api/anything')
                .set('x-internal-secret', FIXED_LEGACY_SECRET);

            const metricsBody = await request(app).get('/metrics');
            expect(
                readMetricSample(metricsBody.text, 'legacy-secret', 'accept')
            ).toBeGreaterThanOrEqual(1);
            expect(
                readMetricSample(metricsBody.text, 'service-jwt', 'accept')
            ).toBe(0);
        });

        test('increments source=rejected,outcome=reject on a tampered JWT', async () => {
            const tampered = `${mintToken()}x`;
            const app = createApp();
            await request(app)
                .get('/api/anything')
                .set('x-service-authorization', `Bearer ${tampered}`);

            const metricsBody = await request(app).get('/metrics');
            expect(
                readMetricSample(metricsBody.text, 'rejected', 'reject')
            ).toBeGreaterThanOrEqual(1);
        });

        test('increments source=anonymous,outcome=reject when no credentials are presented', async () => {
            const app = createApp();
            await request(app).get('/api/anything');

            const metricsBody = await request(app).get('/metrics');
            expect(
                readMetricSample(metricsBody.text, 'anonymous', 'reject')
            ).toBeGreaterThanOrEqual(1);
        });

        test('exposes the counter with the pinned labelNames and help text on /metrics', async () => {
            const app = createApp();
            await request(app).get('/api/anything'); // emit one sample

            const metricsBody = await request(app).get('/metrics');
            expect(metricsBody.text).toMatch(
                /^# HELP auth_internal_boundary_total /m
            );
            expect(metricsBody.text).toMatch(
                /^# TYPE auth_internal_boundary_total counter$/m
            );
            // No raw token / secret bytes ever leak into the exposition.
            expect(metricsBody.text).not.toContain(FIXED_JWT_SECRET);
            expect(metricsBody.text).not.toContain(FIXED_LEGACY_SECRET);
        });
    });
});

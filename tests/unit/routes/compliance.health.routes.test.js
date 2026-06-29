// tests/unit/routes/compliance.health.routes.test.js
//
// A.6 — GET /compliance (readyz-style conformance assertion).
//
// The endpoint returns a structured object asserting this service is
// conformant:
//   * service-JWT verify key present (EdDSA registry has ≥1 kid),
//   * outbox dispatcher heartbeat fresh (HR has an outbox),
//   * key/cert not expired.
// 200 when all checks pass; 503 + reasons[] when any fail.
//
// The router is a factory (mirrors createHealthRouter) so checks are injected:
// no real key registry, no real Redis, no clock dependence in tests.
import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { createComplianceHealthRouter } from '../../../src/routes/complianceHealth.routes.js';

function buildApp(deps) {
    const app = express();
    app.use(createComplianceHealthRouter(deps));
    return app;
}

const conformantDeps = () => ({
    // verify key present
    knownKids: () => ['rbac-svc-9057db2a'],
    // outbox dispatcher heartbeat fresh (recent timestamp)
    outboxHeartbeat: async () => ({ ok: true, lastBeatMs: Date.now() - 1000, staleMs: 1000 }),
    // no key/cert expiry problems
    keyExpiry: () => ({ ok: true, soonestExpiry: null }),
    now: () => new Date('2026-06-24T00:00:00.000Z'),
});

describe('GET /compliance (A.6)', () => {
    it('returns 200 with a structured conformance object when all checks pass', async () => {
        const res = await request(buildApp(conformantDeps())).get('/compliance');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            status: 'conformant',
            service: 'erp-hr-backend',
            checks: {
                signingKey: { status: 'ok' },
                outbox: { status: 'ok' },
                keyExpiry: { status: 'ok' },
            },
        });
        expect(Array.isArray(res.body.reasons)).toBe(true);
        expect(res.body.reasons).toHaveLength(0);
        expect(typeof res.body.timestamp).toBe('string');
    });

    it('returns 503 + reasons[] when the verify key is missing', async () => {
        const deps = conformantDeps();
        deps.knownKids = () => []; // no EdDSA keys loaded
        const res = await request(buildApp(deps)).get('/compliance');

        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not_conformant');
        expect(res.body.checks.signingKey.status).toBe('fail');
        expect(res.body.reasons.length).toBeGreaterThan(0);
        expect(res.body.reasons.join(' ')).toMatch(/key/i);
    });

    it('returns 503 + reasons[] when the outbox dispatcher heartbeat is stale', async () => {
        const deps = conformantDeps();
        deps.outboxHeartbeat = async () => ({
            ok: false,
            lastBeatMs: Date.now() - 10 * 60_000,
            staleMs: 10 * 60_000,
        });
        const res = await request(buildApp(deps)).get('/compliance');

        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not_conformant');
        expect(res.body.checks.outbox.status).toBe('fail');
        expect(res.body.reasons.join(' ')).toMatch(/outbox|heartbeat|dispatcher/i);
    });

    it('returns 503 + reasons[] when a key/cert is expired', async () => {
        const deps = conformantDeps();
        deps.keyExpiry = () => ({ ok: false, soonestExpiry: '2026-01-01T00:00:00.000Z', expired: true });
        const res = await request(buildApp(deps)).get('/compliance');

        expect(res.status).toBe(503);
        expect(res.body.checks.keyExpiry.status).toBe('fail');
        expect(res.body.reasons.join(' ')).toMatch(/expir/i);
    });

    it('never throws if a check rejects — degrades to 503 with a reason', async () => {
        const deps = conformantDeps();
        deps.outboxHeartbeat = async () => {
            throw new Error('redis down');
        };
        const res = await request(buildApp(deps)).get('/compliance');

        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not_conformant');
        expect(res.body.checks.outbox.status).toBe('fail');
    });
});

// C.2 / T-P2.2 — end-to-end proof that a mutating HR endpoint REPLAYS on a
// repeated Idempotency-Key. This wires the REAL idempotency() middleware (the
// same factory mounted on POST /api/leaves/requests in src/routes/leave.routes.js)
// in front of a counting handler and drives it over real HTTP via supertest:
//   * two POSTs with the SAME Idempotency-Key run the handler ONCE and return the
//     identical cached body/status on the replay;
//   * a different key runs the handler again;
//   * the cache is namespaced by the verified tenant, so the same key under a
//     different tenant does NOT replay across tenants.
import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { idempotency } from '../../src/middlewares/idempotency.middleware.js';

// A tiny app mirroring the production wiring: a guard that sets the VERIFIED
// tenant on req.user (as internalServiceGuard does from the signed claim), then
// idempotency(), then a handler that increments a per-process call counter so we
// can observe whether the side effect ran.
function makeApp() {
    const app = express();
    app.use(express.json());

    const calls = { n: 0 };
    // Simulate the verified-tenant guard: tenant comes from a test header that
    // stands in for the signed-claim-derived req.user.tenantId.
    app.use((req, _res, next) => {
        req.user = { tenantId: req.headers['x-test-tenant'] || null, userId: 1 };
        next();
    });
    app.post('/api/leaves/requests', idempotency(), (req, res) => {
        calls.n += 1;
        res.status(201).json({ id: calls.n, created: true });
    });

    return { app, calls };
}

const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

describe('C.2 idempotent mutating endpoint — repeated Idempotency-Key replays', () => {
    it('two POSTs with the SAME key run the handler ONCE and replay the first response', async () => {
        const { app, calls } = makeApp();
        const key = 'idem-key-1';

        const first = await request(app)
            .post('/api/leaves/requests')
            .set('x-test-tenant', TENANT_A)
            .set('Idempotency-Key', key)
            .send({ employeeId: 1 });
        expect(first.status).toBe(201);
        expect(first.body).toEqual({ id: 1, created: true });

        const replay = await request(app)
            .post('/api/leaves/requests')
            .set('x-test-tenant', TENANT_A)
            .set('Idempotency-Key', key)
            .send({ employeeId: 1 });
        expect(replay.status).toBe(201);
        // Identical body — the FIRST response is replayed, not a new id.
        expect(replay.body).toEqual({ id: 1, created: true });

        // The side effect ran exactly once.
        expect(calls.n).toBe(1);
    });

    it('a DIFFERENT key runs the handler again (no false replay)', async () => {
        const { app, calls } = makeApp();

        await request(app).post('/api/leaves/requests').set('x-test-tenant', TENANT_A).set('Idempotency-Key', 'k-a').send({});
        await request(app).post('/api/leaves/requests').set('x-test-tenant', TENANT_A).set('Idempotency-Key', 'k-b').send({});
        expect(calls.n).toBe(2);
    });

    it('no Idempotency-Key → every POST runs (no caching)', async () => {
        const { app, calls } = makeApp();
        await request(app).post('/api/leaves/requests').set('x-test-tenant', TENANT_A).send({});
        await request(app).post('/api/leaves/requests').set('x-test-tenant', TENANT_A).send({});
        expect(calls.n).toBe(2);
    });

    it('the same key under a DIFFERENT tenant does not replay across tenants', async () => {
        const { app, calls } = makeApp();
        const key = 'shared-key';

        const a = await request(app).post('/api/leaves/requests').set('x-test-tenant', TENANT_A).set('Idempotency-Key', key).send({});
        const b = await request(app).post('/api/leaves/requests').set('x-test-tenant', TENANT_B).set('Idempotency-Key', key).send({});

        expect(a.body.id).toBe(1);
        // Tenant B is a different namespace → its handler runs (id 2), no replay of A.
        expect(b.body.id).toBe(2);
        expect(calls.n).toBe(2);
    });
});

// C.2 / T-P2.2 — Idempotency-Key support on HR mutating endpoints.
//
// Mirrors comms/pm: an `Idempotency-Key` header (or body.idempotencyKey) makes a
// mutating request replay the FIRST response on a repeat — store + replay — so a
// retried POST never double-applies. The cache is namespaced by the VERIFIED
// tenant (req.user.tenantId from the signed claim — T-P2.1/X-02), never a
// spoofable header.
//
// These specs drive the express adapter with an injected in-memory store and a
// mock req/res, asserting: (1) first call runs the handler + caches the 2xx
// response; (2) a repeat with the SAME key replays the cached body WITHOUT
// re-running the handler; (3) no key → pass-through; (4) a different tenant with
// the same key is a DIFFERENT namespace (no cross-tenant replay).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { idempotency } from '../../../src/middlewares/idempotency.middleware.js';
import { createMemoryStore } from '../../../src/lib/idempotency-store.js';

const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

function mockRes() {
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

function mockReq({ key, tenantId = TENANT_A, method = 'POST', path = '/api/leaves/requests' } = {}) {
    return {
        method,
        path,
        headers: key ? { 'idempotency-key': key } : {},
        body: {},
        user: { tenantId, userId: 1 },
    };
}

describe('idempotency middleware', () => {
    let store;
    beforeEach(() => { store = createMemoryStore({ ttlMs: 60000 }); });

    it('passes through when no Idempotency-Key is present', () => {
        const mw = idempotency({ store });
        const req = mockReq({ key: undefined });
        const res = mockRes();
        const next = jest.fn();
        mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('first call runs the handler and caches the 2xx response', () => {
        const mw = idempotency({ store });
        const req = mockReq({ key: 'k-1' });
        const res = mockRes();
        const next = jest.fn(() => { res.status(201).json({ id: 7, ok: true }); });
        mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({ id: 7, ok: true });
    });

    it('a repeat with the SAME key replays the cached response WITHOUT re-running the handler', () => {
        // First request commits the response.
        const mw1 = idempotency({ store });
        const req1 = mockReq({ key: 'k-2' });
        const res1 = mockRes();
        const next1 = jest.fn(() => { res1.status(201).json({ id: 42 }); });
        mw1(req1, res1, next1);
        expect(next1).toHaveBeenCalledTimes(1);

        // Replay: same tenant + key. Handler must NOT run; cached body replays.
        const mw2 = idempotency({ store });
        const req2 = mockReq({ key: 'k-2' });
        const res2 = mockRes();
        const next2 = jest.fn();
        mw2(req2, res2, next2);
        expect(next2).not.toHaveBeenCalled();
        expect(res2.statusCode).toBe(201);
        expect(res2.body).toEqual({ id: 42 });
    });

    it('a non-2xx response is NOT cached (the next attempt re-runs the handler)', () => {
        const mw = idempotency({ store });
        const req1 = mockReq({ key: 'k-err' });
        const res1 = mockRes();
        const next1 = jest.fn(() => { res1.status(400).json({ error: 'bad' }); });
        mw(req1, res1, next1);

        const req2 = mockReq({ key: 'k-err' });
        const res2 = mockRes();
        const next2 = jest.fn(() => { res2.status(201).json({ id: 9 }); });
        mw(req2, res2, next2);
        expect(next2).toHaveBeenCalledTimes(1);
        expect(res2.statusCode).toBe(201);
    });

    it('the same key under a DIFFERENT tenant is a different namespace (no cross-tenant replay)', () => {
        const mw = idempotency({ store });
        const reqA = mockReq({ key: 'shared', tenantId: TENANT_A });
        const resA = mockRes();
        mw(reqA, resA, jest.fn(() => { resA.status(201).json({ tenant: 'A' }); }));

        const reqB = mockReq({ key: 'shared', tenantId: TENANT_B });
        const resB = mockRes();
        const nextB = jest.fn(() => { resB.status(201).json({ tenant: 'B' }); });
        mw(reqB, resB, nextB);
        // Tenant B must run its own handler — never replay tenant A's body.
        expect(nextB).toHaveBeenCalledTimes(1);
        expect(resB.body).toEqual({ tenant: 'B' });
    });
});

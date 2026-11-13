// tests/unit/app.correlation.test.js
//
// A.5 + A.6 wiring through the real createApp():
//   * a request with NO x-correlation-id gets one minted + echoed,
//   * a request WITH one reuses it + echoes it back,
//   * GET /compliance returns the structured conformance object (200/503),
//   * /healthz is still unguarded and echoes correlation.
import { jest, describe, test, expect } from '@jest/globals';
import request from 'supertest';

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
    default: {
        $connect: jest.fn().mockResolvedValue(undefined),
        $disconnect: jest.fn().mockResolvedValue(undefined),
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    },
}));

const { createApp } = await import('../../src/app.js');

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('A.5 — x-correlation-id propagation through createApp()', () => {
    test('mints + echoes a correlation id when the header is absent', async () => {
        const res = await request(createApp()).get('/healthz');

        expect(res.status).toBe(200);
        expect(res.headers['x-correlation-id']).toMatch(UUID_RE);
    });

    test('reuses + echoes an inbound correlation id', async () => {
        const res = await request(createApp())
            .get('/healthz')
            .set('x-correlation-id', 'corr-end-to-end-1');

        expect(res.status).toBe(200);
        expect(res.headers['x-correlation-id']).toBe('corr-end-to-end-1');
    });
});

describe('A.6 — GET /compliance through createApp()', () => {
    test('returns a structured conformance object (200 or 503) with the documented shape', async () => {
        const res = await request(createApp()).get('/compliance');

        // In a bare test process no verify key is configured and the dispatcher
        // has never beaten, so this is legitimately 503 + reasons[]. The shape
        // is what we pin here; the per-check status is environment-driven.
        expect([200, 503]).toContain(res.status);
        expect(res.body.service).toBe('erp-hr-backend');
        expect(res.body).toHaveProperty('checks.signingKey');
        expect(res.body).toHaveProperty('checks.outbox');
        expect(res.body).toHaveProperty('checks.keyExpiry');
        expect(Array.isArray(res.body.reasons)).toBe(true);
        expect(typeof res.body.timestamp).toBe('string');
        // /compliance is reachable WITHOUT the /api service-JWT guard.
        expect(res.status).not.toBe(403);
        // echoes correlation too
        expect(res.headers['x-correlation-id']).toBeDefined();
    });
});

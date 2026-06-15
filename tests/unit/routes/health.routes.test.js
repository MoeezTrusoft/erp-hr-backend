// tests/unit/routes/health.routes.test.js
//
// Covers BE-§7.3: /healthz is cheap liveness, /readyz honestly probes
// the DB through prisma. The factory in src/routes/health.routes.js
// accepts an injected prisma so we can drive both success and failure
// paths without a real database.
import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { createHealthRouter } from '../../../src/routes/health.routes.js';

function buildApp(prisma) {
    const app = express();
    app.use(createHealthRouter({ prisma }));
    return app;
}

describe('GET /healthz (liveness)', () => {
    it('returns 200 with the service marker and uptime', async () => {
        // No prisma needed — healthz must survive a DB outage.
        const app = buildApp(null);
        const response = await request(app).get('/healthz');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            status: 'ok',
            service: 'erp-hr-backend',
        });
        expect(typeof response.body.uptimeSeconds).toBe('number');
        expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
        expect(typeof response.body.timestamp).toBe('string');
    });
});

describe('GET /readyz (readiness)', () => {
    it('returns 200 ready when prisma.$queryRaw resolves', async () => {
        const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) };
        const app = buildApp(prisma);

        const response = await request(app).get('/readyz');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            status: 'ready',
            service: 'erp-hr-backend',
            checks: { database: { status: 'ok' } },
        });
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('returns 503 not_ready with the failure reason when prisma rejects', async () => {
        const prisma = {
            $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')),
        };
        const app = buildApp(prisma);

        const response = await request(app).get('/readyz');

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
            status: 'not_ready',
            checks: {
                database: { status: 'fail', error: 'connection refused' },
            },
        });
    });

    it('returns 503 not_ready when no prisma client is configured', async () => {
        // Guards against accidentally mounting the router without
        // injecting a client — the response surfaces the misconfiguration
        // instead of pretending the dependency is healthy.
        const app = buildApp(null);

        const response = await request(app).get('/readyz');

        expect(response.status).toBe(503);
        expect(response.body.checks.database.status).toBe('fail');
        expect(response.body.checks.database.error).toMatch(/prisma client/i);
    });
});

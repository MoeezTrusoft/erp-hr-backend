// ADMS endpoints with the gateway service mocked: unknown devices refused, punches acknowledged
// only after the intake accepted them, stamps echoed back, failures return an error so the device retries.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const forwarded = [];
let failNext = false;
jest.unstable_mockModule('../../../src/services/deviceGateway.service.js', () => ({
    metrics: { requests: { inc() {} }, rows: { inc() {} } },
    findActiveDevice: async (sn) => (sn === 'TTQ5261300360' ? { id: 'd1', sn, timeZone: 'Asia/Karachi' } : null),
    forwardRows: async (args) => {
        if (failNext) { failNext = false; throw Object.assign(new Error('db down'), { status: 500 }); }
        forwarded.push(args);
        return { stored: args.rows.length };
    },
    heartbeat: async () => ({}),
}));
const { createIclockRouter } = await import('../../../src/routes/iclock.routes.js');

function appWithStore() {
    const state = new Map();
    const store = { get: async (k) => state.get(k) ?? null, set: async (k, v) => state.set(k, v) };
    const app = express();
    app.use('/iclock', createIclockRouter({ store }));
    return { app, state };
}

beforeEach(() => { forwarded.length = 0; failNext = false; });

describe('/iclock', () => {
    it('refuses an unregistered serial', async () => {
        const { app } = appWithStore();
        const r = await request(app).get('/iclock/cdata?SN=UNKNOWN123&options=all');
        expect(r.status).toBe(403);
    });

    it('handshakes, stores punches, echoes the stamp next time', async () => {
        const { app } = appWithStore();
        const h1 = await request(app).get('/iclock/cdata?SN=TTQ5261300360&options=all');
        expect(h1.status).toBe(200);
        expect(h1.text).toContain('ATTLOGStamp=0');
        const body = '1043\t2026-11-20 09:00:01\t0\t15\t0\t0\t0\t0\t0\t0\t\n7\t2026-11-20 09:00:05\t1\t1\t0\n';
        const up = await request(app).post('/iclock/cdata?SN=TTQ5261300360&table=ATTLOG&Stamp=9182')
            .set('Content-Type', 'application/push;charset=utf-8').send(body);
        expect(up.status).toBe(200);
        expect(up.text).toBe('OK: 2');
        expect(forwarded[0]).toMatchObject({ sn: 'TTQ5261300360', connector: 'adms', source: 'DEVICE_PUSH' });
        expect(forwarded[0].rows).toHaveLength(2);
        const h2 = await request(app).get('/iclock/cdata?SN=TTQ5261300360&options=all');
        expect(h2.text).toContain('ATTLOGStamp=9182');
    });

    it('does not acknowledge when the intake fails, and keeps the old stamp', async () => {
        const { app, state } = appWithStore();
        failNext = true;
        const r = await request(app).post('/iclock/cdata?SN=TTQ5261300360&table=ATTLOG&Stamp=5').send('1\t2026-11-20 09:00:01\t0\t1\t0\n');
        expect(r.status).toBe(503);
        expect(r.text).not.toMatch(/^OK/);
        expect(state.has('adms-stamp:TTQ5261300360')).toBe(false);
    });

    it('acknowledges and discards other tables', async () => {
        const { app } = appWithStore();
        const r = await request(app).post('/iclock/cdata?SN=TTQ5261300360&table=OPERLOG&Stamp=1').send('OPLOG 4\t0\t2026-11-20 09:00:01\t0\t0\t0\t0\n');
        expect(r.text).toBe('OK: 1');
        expect(forwarded).toHaveLength(0);
    });

    it('answers command polls', async () => {
        const { app } = appWithStore();
        const r = await request(app).get('/iclock/getrequest?SN=TTQ5261300360');
        expect(r.status).toBe(200);
        expect(r.text).toBe('OK');
    });
});

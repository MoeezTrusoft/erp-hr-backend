// tests/unit/middlewares/correlationId.middleware.test.js
//
// A.5 — x-correlation-id propagation. Covers the per-request middleware that:
//   * reads an inbound `x-correlation-id`, or MINTS a uuid when absent,
//   * stores it on req.correlationId,
//   * binds a per-request child logger (logger.child({ correlationId })) on
//     req.log,
//   * echoes the same value back on the response `x-correlation-id` header.
//
// The outbound helper (forwardCorrelationHeader) is also exercised: it merges
// `x-correlation-id` into an outbound header bag so peer-service calls carry
// the same id end-to-end.
import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {
    attachCorrelationId,
    forwardCorrelationHeader,
    CORRELATION_HEADER,
} from '../../../src/middlewares/correlationId.middleware.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildApp() {
    const app = express();
    app.use(attachCorrelationId);
    app.get('/probe', (req, res) => {
        res.json({
            correlationId: req.correlationId,
            hasChildLogger: typeof req.log?.info === 'function',
        });
    });
    return app;
}

describe('attachCorrelationId (A.5)', () => {
    it('mints a uuid correlation id when the inbound header is absent', async () => {
        const res = await request(buildApp()).get('/probe');

        expect(res.status).toBe(200);
        expect(res.body.correlationId).toMatch(UUID_RE);
        // echoed on the response header
        expect(res.headers[CORRELATION_HEADER]).toBe(res.body.correlationId);
    });

    it('reuses an inbound x-correlation-id and echoes it back', async () => {
        const incoming = 'corr-abc-123';
        const res = await request(buildApp())
            .get('/probe')
            .set(CORRELATION_HEADER, incoming);

        expect(res.status).toBe(200);
        expect(res.body.correlationId).toBe(incoming);
        expect(res.headers[CORRELATION_HEADER]).toBe(incoming);
    });

    it('binds a per-request child logger on req.log', async () => {
        const res = await request(buildApp())
            .get('/probe')
            .set(CORRELATION_HEADER, 'corr-xyz');

        expect(res.body.hasChildLogger).toBe(true);
    });

    it('child logger is bound with the request correlationId', () => {
        // Drive the middleware directly with a spyable logger to prove the
        // child binding carries the correlationId.
        const child = { info: jest.fn(), child: jest.fn() };
        const logger = { child: jest.fn(() => child) };
        const req = { headers: { 'x-correlation-id': 'bound-id' } };
        const res = { setHeader: jest.fn() };
        const next = jest.fn();

        attachCorrelationId(req, res, next, { logger });

        expect(logger.child).toHaveBeenCalledWith({ correlationId: 'bound-id' });
        expect(req.log).toBe(child);
        expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', 'bound-id');
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('forwardCorrelationHeader (A.5 outbound)', () => {
    it('injects x-correlation-id from req into an outbound header bag', () => {
        const req = { correlationId: 'fwd-1' };
        const headers = forwardCorrelationHeader(req, { Authorization: 'Bearer x' });

        expect(headers['x-correlation-id']).toBe('fwd-1');
        expect(headers.Authorization).toBe('Bearer x'); // preserves existing
    });

    it('returns a fresh object and never mutates the input bag', () => {
        const original = { a: '1' };
        const out = forwardCorrelationHeader({ correlationId: 'fwd-2' }, original);

        expect(out).not.toBe(original);
        expect(original['x-correlation-id']).toBeUndefined();
    });

    it('is a no-op for the correlation key when req has no correlationId', () => {
        const out = forwardCorrelationHeader({}, { a: '1' });
        expect(out['x-correlation-id']).toBeUndefined();
        expect(out.a).toBe('1');
    });
});

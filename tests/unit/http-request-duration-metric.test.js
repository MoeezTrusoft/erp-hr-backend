// tests/unit/http-request-duration-metric.test.js
// A-RED — RED + USE dashboard support (audit-reports/08-sota-roadmap.md DO-NOW #2).
//
// Proves the additive http_request_duration_seconds histogram surfaces through
// the real createApp() per-app /metrics endpoint. HR builds a fresh private
// client.Registry() per createApp() and attaches shared metrics onto it (same
// pattern as attachInternalBoundaryMetric). This suite drives a real request
// with supertest and reads it back from GET /metrics — proving the histogram is
// registered, observed, labeled by method/route/status_code (+ service=hr), and
// changes NO response.
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

const METRIC = 'http_request_duration_seconds';

describe('http_request_duration_seconds histogram through createApp()', () => {
    test('GET /metrics exposes the histogram with HELP and TYPE lines', async () => {
        const res = await request(createApp()).get('/metrics');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/plain/);
        expect(res.text).toMatch(new RegExp(`^# HELP ${METRIC} `, 'm'));
        expect(res.text).toMatch(new RegExp(`^# TYPE ${METRIC} histogram$`, 'm'));
    });

    test('a real request is observed and exposed with method/route/status_code + service=hr', async () => {
        const app = createApp();

        // /healthz is public and pure — observing it must not change the response.
        const live = await request(app).get('/healthz');
        expect(live.status).toBe(200);

        const metricsBody = await request(app).get('/metrics');
        expect(metricsBody.status).toBe(200);
        expect(metricsBody.text).toMatch(
            new RegExp(`^${METRIC}_count\\{[^}]*\\}\\s+\\d+`, 'm'),
        );
        expect(metricsBody.text).toMatch(new RegExp(`^${METRIC}_bucket\\{`, 'm'));
        expect(metricsBody.text).toMatch(/method="GET"/);
        expect(metricsBody.text).toMatch(/status_code="200"/);
        expect(metricsBody.text).toMatch(/service="hr"/);
    });

    test('does not widen route cardinality from arbitrary unmatched paths', async () => {
        const app = createApp();
        await request(app).get('/__nope__/' + Date.now());
        const metricsBody = await request(app).get('/metrics');
        expect(metricsBody.text).not.toMatch(/route="\/__nope__/);
    });
});

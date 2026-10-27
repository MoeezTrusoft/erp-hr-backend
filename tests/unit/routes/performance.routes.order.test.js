// tests/unit/routes/performance.routes.order.test.js — PERF-P0 (D15).
//
// Literal performance paths must be registered BEFORE the `/:employeeId` and
// `/:id` params, otherwise `/metrics`, `/nine-box`, `/feedback` and
// `/reviews/:reviewId/items` are swallowed as an employee id, and the review
// routers must not register duplicate (unreachable) handlers.
import { describe, it, expect } from '@jest/globals';

const stackOf = (router) =>
    router.stack
        .filter((layer) => layer.route)
        .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

const performanceRoutes = (await import('../../../src/routes/performance.routes.js')).default;
const reviewRoutes = (await import('../../../src/routes/performanceReview.routes.js')).default;
const alignmentRoutes = (await import('../../../src/routes/goalAlignment.routes.js')).default;

describe('performance route ordering', () => {
    it('registers literal paths before the parameterised ones', () => {
        const paths = stackOf(performanceRoutes);
        const firstParam = paths.findIndex((p) => /^(GET|PUT) \/:(employeeId|id)$/.test(p));
        for (const literal of ['GET /metrics', 'GET /nine-box', 'POST /feedback', 'GET /reviews/:reviewId/items']) {
            expect(paths.indexOf(literal)).toBeGreaterThanOrEqual(0);
            expect(paths.indexOf(literal)).toBeLessThan(firstParam);
        }
    });

    it('has no duplicate method+path registrations', () => {
        for (const router of [performanceRoutes, reviewRoutes, alignmentRoutes]) {
            const paths = stackOf(router);
            expect(new Set(paths).size).toBe(paths.length);
        }
    });

    it('declares the params the controllers read', () => {
        expect(stackOf(reviewRoutes)).toContain('GET /cycle/:cycleId');
        expect(stackOf(alignmentRoutes)).toContain('GET /:goalId');
    });
});

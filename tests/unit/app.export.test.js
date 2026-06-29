// tests/unit/app.export.test.js
//
// A-HR-TESTABLE-APP-FOUNDATION foundation tests.
//
// These assertions pin the contract that src/server.js now relies on:
//
//   1. `createApp()` from src/app.js returns a fully-wired Express
//      handler without binding any port or starting any background
//      worker. This is what unblocks future integration / performance
//      suites: they can `import { createApp }` and drive supertest
//      against it without setting up the attendance bootstrap or
//      socket.io transport.
//
//   2. The /healthz liveness route survives the extraction and still
//      answers from the app handle (no DB call).
//
//   3. The internal-secret gate on /api/* still rejects calls with no
//      `x-internal-secret` header (403) and still surfaces a 500 when
//      the env var is unset, exactly matching server.js's previous
//      behaviour.
//
//   4. With the right secret the gate falls through to the rest of
//      the router stack -- so the wiring order (gate before route
//      mounts) is preserved.
//
// We do not import src/server.js: doing so would start the http
// listener, register signal handlers, and kick off the attendance
// scheduler under Jest. That's exactly the side-effect surface this
// refactor is designed to isolate.
import { jest, describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import request from 'supertest';

// Prisma is imported transitively through the route tree. Stub the
// $queryRaw / $connect / $disconnect surface to a no-op so importing
// the app does not need an actual database, and so /healthz (which
// does not touch the DB) does not flake on environments without one.
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
    default: {
        $connect: jest.fn().mockResolvedValue(undefined),
        $disconnect: jest.fn().mockResolvedValue(undefined),
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    },
}));

const { createApp } = await import('../../src/app.js');

const ORIGINAL_SECRET = process.env.INTERNAL_SERVICE_SECRET;

describe('src/app.js — testable app foundation', () => {
    beforeEach(() => {
        // Each test sets its own value (or deletes the var) so we
        // never leak between cases. Post-sunset the gate keys on
        // SERVICE_JWT_SECRET, so reset it too for determinism.
        delete process.env.INTERNAL_SERVICE_SECRET;
        delete process.env.SERVICE_JWT_SECRET;
    });

    afterAll(() => {
        if (ORIGINAL_SECRET === undefined) {
            delete process.env.INTERNAL_SERVICE_SECRET;
        } else {
            process.env.INTERNAL_SERVICE_SECRET = ORIGINAL_SECRET;
        }
    });

    describe('factory shape', () => {
        test('createApp() returns an Express request handler without listening', () => {
            const app = createApp();

            // Express apps are callable request handlers and expose
            // .listen / .use / .get. We assert the shape rather than
            // attempt any actual binding -- the absence of side
            // effects is the entire point of the factory.
            expect(typeof app).toBe('function');
            expect(typeof app.listen).toBe('function');
            expect(typeof app.use).toBe('function');
            expect(typeof app.get).toBe('function');
        });

        test('createApp() can be called twice without conflicting global state', () => {
            // If the factory mutated module-scope state -- a shared
            // router, a registered prom-client metric, anything --
            // the second call would throw. This nails down that
            // src/app.js is a pure factory.
            const a = createApp();
            const b = createApp();

            expect(a).not.toBe(b);
            expect(typeof a.listen).toBe('function');
            expect(typeof b.listen).toBe('function');
        });
    });

    describe('healthz survives the extraction', () => {
        test('GET /healthz returns 200 with the liveness envelope', async () => {
            process.env.INTERNAL_SERVICE_SECRET = 'test-secret';

            const response = await request(createApp()).get('/healthz');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('ok');
            expect(response.body.service).toBeDefined();
            expect(typeof response.body.uptimeSeconds).toBe('number');
        });
    });

    // Post-sunset (T-P6.1): the internal boundary is the service-JWT gate.
    // The legacy X-Internal-Secret ACCEPT path is removed; the gate keys on
    // SERVICE_JWT_SECRET and a verified X-Service-Authorization token.
    describe('service-JWT gate', () => {
        test('rejects /api/* with 403 when no service token is sent', async () => {
            process.env.SERVICE_JWT_SECRET = 'svc-secret';

            const response = await request(createApp())
                .get('/api/this-path-does-not-need-to-exist');

            expect(response.status).toBe(403);
            expect(response.body.success).toBe(false);
            expect(response.body.message).toMatch(/direct service access/i);
        });

        test('rejects /api/* with 401 when the service token is invalid', async () => {
            process.env.SERVICE_JWT_SECRET = 'svc-secret';

            const response = await request(createApp())
                .get('/api/this-path-does-not-need-to-exist')
                .set('x-service-authorization', 'Bearer not.a.valid.jwt');

            expect(response.status).toBe(401);
            expect(response.body.success).toBe(false);
        });

        test('a valid X-Internal-Secret is NO LONGER honored (legacy accept removed)', async () => {
            // Pre-sunset this fell through to 404 (gate passed). Now the legacy
            // accept path is gone, so even a matching secret is rejected — only
            // a service-JWT authenticates.
            process.env.SERVICE_JWT_SECRET = 'svc-secret';
            process.env.INTERNAL_SERVICE_SECRET = 'real-secret';

            const response = await request(createApp())
                .get('/api/this-path-does-not-need-to-exist')
                .set('x-internal-secret', 'real-secret');

            expect(response.status).toBe(403);
            expect(response.status).not.toBe(404);
        });

        test('returns 500 when SERVICE_JWT_SECRET is unset on the process (fail closed)', async () => {
            // beforeEach deletes both secrets; this asserts the fail-closed
            // misconfiguration branch now keyed on SERVICE_JWT_SECRET.
            const response = await request(createApp())
                .get('/api/anything');

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
            expect(response.body.message).toMatch(/not configured/i);
        });

        test('leaves non-/api routes (e.g. /healthz) unguarded by the secret', async () => {
            // /healthz must work for the gateway / kubelet probe
            // without ever owning the internal secret. Regression
            // guard for "did someone widen the gate to '/' ?"
            const response = await request(createApp()).get('/healthz');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('ok');
        });
    });
});

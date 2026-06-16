// tests/unit/performance/training.performance.test.js
//
// Deferred. This suite is a *performance* harness: it issues 100 parallel
// POSTs to /api/training/courses and 50 concurrent POSTs to
// /api/training/enrollments through supertest, writing rows through Prisma
// against the erp-hr database and timing the round-trips. It is not a
// unit test and cannot be safely revived in this lane.
//
// Concrete blockers (each must be resolved before this suite can move out
// of `describe.skip`):
//
//   1. [RESOLVED 2026-06-16 by A-HR-TESTABLE-APP-FOUNDATION]
//      A testable app factory now exists at `src/app.js` (`createApp()`),
//      and `src/server.js` only invokes it during runtime bootstrap.
//      When this suite is revived it should
//      `import { createApp } from '../../src/app.js'` and drive
//      supertest against a fresh app per `beforeAll`, instead of the
//      original side-effectful `import app from '../../src/server.js'`.
//
//   2. No test database. The harness reads and writes
//      `trainingCategory`, `trainingCourse`, `trainingEnrollment`, and
//      `employee` through `src/config/prisma.js`. Pointing this at a
//      shared dev database would create real rows and is not acceptable;
//      the dedicated `erp-hr-test` database + per-suite isolation work
//      lives with the same P2 ticket.
//
//   3. Internal-service secret gate. `app.use("/api", requireInternalService)`
//      in src/server.js rejects any request without
//      `x-internal-secret: $INTERNAL_SERVICE_SECRET`. The original tests
//      never set this header, so even with #1 + #2 the suite would 403
//      out of the box. A test fixture that injects the gateway-style
//      headers belongs alongside the app export work.
//
//   4. Performance suites belong outside the unit gate. Wall-clock
//      assertions (`expect(endTime - startTime).toBeLessThan(10000)`) are
//      noisy under CI parallelism and the gate-p1 unit step should stay
//      deterministic. When this suite is revived it will live behind a
//      separate `npm run test:perf` runner, not the default Jest
//      `--passWithNoTests --silent` invocation in gate-p1.sh.
//
// Until those four items land, the safe option is to keep the original
// describe.skip in place with this blocker note attached. The placeholder
// `expect(true).toBe(true)` is intentional — it asserts the file is
// runnable under Jest so the gate does not silently miss a syntax
// regression in this fixture while the suite is parked.
import { describe, it, expect } from '@jest/globals';

describe.skip('Training Module Performance Tests (deferred: needs erp-hr-test DB, internal-secret fixture, perf runner)', () => {
    it('placeholder', () => {
        expect(true).toBe(true);
    });
});

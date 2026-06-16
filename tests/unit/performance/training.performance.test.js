// tests/unit/performance/training.performance.test.js
//
// Deferred. This suite is a *performance* harness: it issues 100 parallel
// POSTs to /api/training/courses and 50 concurrent POSTs to
// /api/training/enrollments through supertest, writing rows through Prisma
// against the erp-hr database and timing the round-trips. It is not a
// unit test and cannot be safely revived until the one remaining blocker
// below is closed.
//
// Status of the original four blockers:
//
//   1. [RESOLVED 2026-06-16 by A-HR-TESTABLE-APP-FOUNDATION]
//      A testable app factory now exists at `src/app.js` (`createApp()`),
//      and `src/server.js` only invokes it during runtime bootstrap.
//      When this suite is revived it should
//      `import { createApp } from '../../src/app.js'` and drive
//      supertest against a fresh app per `beforeAll`, instead of the
//      original side-effectful `import app from '../../src/server.js'`.
//
//   2. [OPEN] No test database. The harness reads and writes
//      `trainingCategory`, `trainingCourse`, `trainingEnrollment`, and
//      `employee` through `src/lib/prisma.js`. Pointing this at a
//      shared dev database would create real rows and is not acceptable;
//      a dedicated `erp-hr-test` database plus per-suite isolation
//      (transactional rollback per test, or per-run schema reset) must
//      land before the suite stops being skipped. Until then, the
//      $.env.TEST_DATABASE_URL convention documented in
//      tests/README.md should be honoured.
//
//   3. [RESOLVED 2026-06-16 by A-HR-PERF-RUNNER-FOUNDATION]
//      Gateway-style headers (including `x-internal-secret`) are now
//      produced by `tests/helpers/internal-gateway.js`. When this suite
//      is revived, import `gatewayHeaders` from that helper and apply
//      it to every supertest call:
//        request(app).post('/api/training/courses')
//          .set(gatewayHeaders({ user: { id: 1, roles: ['HR_ADMIN'] } }))
//          .send(...)
//      INTERNAL_SERVICE_SECRET must be on process.env at suite startup
//      (tests/README.md documents how to inject it).
//
//   4. [RESOLVED 2026-06-16 by A-HR-PERF-RUNNER-FOUNDATION]
//      Wall-clock perf assertions now live behind a dedicated runner.
//      Files matching `*.performance.test.js` are excluded from the
//      default `npm test` / `gate:p1` Jest invocation by the
//      `testPathIgnorePatterns` entry in `jest.config.js`, and the
//      new `npm run test:perf` script clears that exclusion on the
//      CLI so the suite runs only when explicitly requested.
//
// Until blocker #2 lands, the safe option is to keep `describe.skip`
// in place with this blocker note attached. The placeholder
// `expect(true).toBe(true)` is intentional — it asserts the file is
// runnable under Jest so a syntax regression here would still surface
// the next time `npm run test:perf` is invoked.
import { describe, it, expect } from '@jest/globals';

describe.skip('Training Module Performance Tests (deferred: needs erp-hr-test DB + isolation)', () => {
    it('placeholder', () => {
        expect(true).toBe(true);
    });
});

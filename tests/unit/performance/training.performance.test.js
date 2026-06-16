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
//   2. [PARTIALLY RESOLVED 2026-06-16 by A-HR-TEST-DB-FOUNDATION]
//      The test-DB foundation now exists:
//        - `tests/helpers/test-db.js` exposes `getTestPrisma()`,
//          `resetTestDatabase()`, `requireTestDatabaseUrl()`, and
//          `disconnectTestPrisma()`. The helper builds its own
//          PrismaClient bound to TEST_DATABASE_URL and never touches
//          the runtime singleton in src/lib/prisma.js.
//        - URL safety: only postgres URLs whose database name
//          contains "test" (and contains no prod/staging/main/live
//          hint in name or host) are accepted. Error messages never
//          echo the password or full URL.
//        - Isolation: TRUNCATE ... RESTART IDENTITY CASCADE between
//          tests, against the four tables this suite writes
//          (TrainingEnrollment, TrainingCourse, TrainingCategory,
//          Employee). True transactional rollback would require a
//          services-level refactor and is intentionally deferred.
//        - tests/README.md documents how to provision erp-hr-test,
//          the TEST_DATABASE_URL format, and the hard rules around
//          never pointing it at dev/staging/prod.
//      Open work to fully close this blocker:
//        a. CI / contributor environment must actually provision
//           `erp-hr-test` and inject TEST_DATABASE_URL.
//        b. This suite's contents must be rewritten on top of the
//           helper (see "next steps for the future unskip lane"
//           below).
//      Until both (a) and (b) land, `describe.skip` stays in place.
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
// Next steps for the future unskip lane (in order):
//
//   1. Provision `erp-hr-test` (see tests/README.md > "Provisioning
//      erp-hr-test") and inject TEST_DATABASE_URL into the CI runner
//      that calls `npm run test:perf`.
//   2. Replace the imports at the top of this file with:
//        import { createApp } from '../../../src/app.js';
//        import { gatewayHeaders } from '../../helpers/internal-gateway.js';
//        import {
//          getTestPrisma,
//          resetTestDatabase,
//          disconnectTestPrisma,
//        } from '../../helpers/test-db.js';
//   3. Drive every supertest call through `createApp()` and apply
//      `gatewayHeaders({ user: { id: ..., roles: ['HR_ADMIN'] } })`.
//   4. Use `getTestPrisma()` (NOT the runtime singleton) for any
//      direct row inserts (course / enrollment setup), and call
//      `resetTestDatabase()` in `beforeEach` so each `it` starts
//      with empty tables. Call `disconnectTestPrisma()` in `afterAll`.
//   5. Remove `describe.skip` and the placeholder `it`. The wall-clock
//      assertions can stay as written -- they only run under
//      `npm run test:perf`, which is excluded from `gate:p1`.
//
// Until those steps land, the safe option is to keep `describe.skip`
// in place. The placeholder `expect(true).toBe(true)` is intentional --
// it asserts the file is runnable under Jest so a syntax regression
// here would still surface the next time `npm run test:perf` is
// invoked.
import { describe, it, expect } from '@jest/globals';

describe.skip('Training Module Performance Tests (deferred: needs erp-hr-test DB provisioned + helper adoption)', () => {
    it('placeholder', () => {
        expect(true).toBe(true);
    });
});

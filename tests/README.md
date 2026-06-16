# `erp-hr-backend` testing runbook

This document covers the **test runners**, **fixtures**, and **DB
expectations** that live in this directory. Architecture lives in
`docs/` (project root) and is read-only — anything in this file is
specific to the test harness.

## Runners

| Command | What it runs | Used in CI gate? |
| --- | --- | --- |
| `npm test` | Default Jest suite. Excludes any file matching `*.performance.test.js` via `testPathIgnorePatterns` in `jest.config.js`. | Yes — invoked by `scripts/gate-p1.sh` step 1. |
| `npm run test:unit` | Same default behaviour, but scoped to `tests/unit`. | No. |
| `npm run test:integration` | Same default behaviour, scoped to `tests/integration`. | No. |
| `npm run test:e2e` | Same default behaviour, scoped to `tests/e2e`. | No. |
| `npm run test:perf` | Wall-clock performance suites. Overrides `testPathIgnorePatterns` on the CLI and applies `--testPathPatterns=performance\.test\.js$` so only files matching the suffix run. **Not** in `gate:p1`. | No. |

### Why `test:perf` is separate

`*.performance.test.js` suites use assertions like
`expect(endTime - startTime).toBeLessThan(10000)`. Those are inherently
noisy under CI parallelism — a slow worker or a contended database can
make a passing branch fail without anyone changing code. The
`gate:p1` unit step must stay deterministic, so perf files are
excluded by default and only run when `npm run test:perf` is invoked
explicitly. A future CI pipeline can call `test:perf` on a dedicated
runner with a quiet host and its own threshold policy.

## Gateway-style header fixture

Any test that drives the real Express app via supertest has to clear
the `/api` internal-secret gate **and** populate the `x-user-*`
context headers that `attachHrContext` reads. Hard-coding those in
each suite drifts and leaks secrets into snapshots, so we centralise
that knowledge in `tests/helpers/internal-gateway.js`.

```js
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { gatewayHeaders } from '../helpers/internal-gateway.js';

beforeAll(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'test-secret';
});

test('happy-path', async () => {
    const res = await request(createApp())
        .post('/api/training/courses')
        .set(gatewayHeaders({
            user: { id: 1, employeeId: 7, tenantId: 1, roles: ['HR_ADMIN'] },
        }))
        .send({ title: 'Onboarding 101' });

    expect(res.status).toBe(201);
});
```

`gatewayHeaders()` reads `INTERNAL_SERVICE_SECRET` from `process.env`
on **every call**, so per-test mutation of the var is honoured. It
throws a non-leaking error if the var is unset rather than emitting a
header with `undefined` as the value (which would fail the gate with a
misleading 403). It JSON-encodes `roles` and `permissions`, stringifies
numeric ids, and coerces `isAdmin` to the literal strings `"true"` /
`"false"` so the wire shape matches `attachHrContext`'s expectations
exactly.

For the bare minimum (just clear the secret gate without setting any
user context), use `internalServiceHeaders()` from the same file.

## DB expectations

Today, the unit lane uses **mocked Prisma**. No suite under
`tests/unit` is allowed to touch a real database — services that
import Prisma are mocked with `jest.unstable_mockModule(...)` at the
top of each affected suite, and a tracking inventory of the prisma
singleton lives in `tests/unit/lib/prisma.singleton.test.js`.

Wall-clock perf suites (`*.performance.test.js`) **do** need a real
database. The current parked suite (`training.performance.test.js`) is
held behind `describe.skip` until the project has:

1. A dedicated `erp-hr-test` database (separate from any dev /
   staging instance).
2. A per-suite isolation policy — either a `prisma.$transaction` /
   rollback wrapper per `it`, or a schema reset between runs.
3. A `TEST_DATABASE_URL` env convention so `src/lib/prisma.js` can
   point at the test database during `npm run test:perf` without
   touching production config.

When that lands, the perf suite owners should:

- Remove `describe.skip` from `training.performance.test.js`.
- Switch `import app from '../../src/server.js'` to
  `import { createApp } from '../../src/app.js'`.
- Apply `gatewayHeaders(...)` to every supertest call.
- Add a per-test cleanup step (delete-many on the affected tables).

The file-level header in `training.performance.test.js` tracks all
four blockers and shows which remain open.

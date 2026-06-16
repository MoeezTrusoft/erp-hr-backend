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
held behind `describe.skip` for one remaining reason: nobody has
provisioned the `erp-hr-test` database and pointed CI at it. The test
infrastructure that consumes it -- the helper described below -- is
already in place.

### The test-DB helper (`tests/helpers/test-db.js`)

The helper is the bridge between a DB-backed suite and a real
Postgres test database. It is deliberately self-contained:

- **It builds its own `PrismaClient`.** Importantly, the runtime
  singleton in `src/lib/prisma.js` is **not** touched -- production
  prisma stays bound to `DATABASE_URL` exactly as it does today, and
  the helper's client uses `datasourceUrl: TEST_DATABASE_URL` only.
  There is no risk that the default `npm test` or `npm run gate:p1`
  silently routes a query at the test database.
- **It refuses unsafe URLs.** Before any client is constructed,
  `assertSafeTestDatabaseUrl` enforces: postgres scheme, non-empty
  database name, the name must contain `"test"`, and neither the
  database name nor the host may contain `prod`, `production`,
  `live`, `staging`, `main`, or `master` (case-insensitive,
  underscore-aware).
- **It never logs full URLs.** Error messages echo only the parsed
  database name and (for host violations) the hostname. The password
  and full URL never reach the error stream.
- **It requires `NODE_ENV=test`.** A future commit that accidentally
  imports the helper from `src/` will fail loudly instead of opening
  a connection.

Exported API (see `tests/helpers/test-db.js` for the JSDoc shape):

| Function | Use |
| --- | --- |
| `assertSafeTestDatabaseUrl(url)` | Throw if the supplied URL looks unsafe. Used internally; useful for explicit env validation in a suite's `beforeAll`. |
| `requireTestDatabaseUrl()` | Returns the safe `TEST_DATABASE_URL` or throws. |
| `getTestPrisma()` | Returns a cached `PrismaClient` bound to `TEST_DATABASE_URL`. First call constructs; subsequent calls reuse. |
| `disconnectTestPrisma()` | `$disconnect`s and clears the cache. Call in `afterAll`. |
| `resetTestDatabase({ tables })` | `TRUNCATE TABLE ... RESTART IDENTITY CASCADE`. Defaults to the four tables the parked perf suite writes (`TrainingEnrollment`, `TrainingCourse`, `TrainingCategory`, `Employee`). Refuses any table name not matching `[A-Za-z_][A-Za-z0-9_]*` so a stray string can never reach `$executeRawUnsafe`. |

### Isolation strategy

The chosen isolation strategy is **TRUNCATE between tests**, not
transactional rollback. Why:

- HR services import the module-singleton `prisma` from
  `src/lib/prisma.js` directly. There is no clean way to thread a
  `prisma.$transaction(async (tx) => {...})` callback's `tx` scope
  through the service surface without refactoring every service.
- TRUNCATE matches what the existing
  `training.performance.test.js` `afterAll` block already does
  (`deleteMany`), so the suite's contract is unchanged when it is
  finally revived.
- The helper's `resetTestDatabase` runs `RESTART IDENTITY CASCADE`
  so sequences are reset and any cross-FKs are handled.

If a future lane refactors services to accept an injected `tx`
scope, transactional rollback can be added on top of this helper
without changing its public API.

### Required `TEST_DATABASE_URL` format

```
postgres://<user>:<password>@<host>:<port>/<dbname>
postgresql://<user>:<password>@<host>:<port>/<dbname>
```

- The database name **must** contain the substring `test`
  (case-insensitive). The recommended name is `erp_hr_test`.
- Neither the host nor the database name may contain
  `prod`/`production`/`live`/`staging`/`main`/`master`. The helper
  will refuse to connect if either does.
- Recommended local-dev value:
  `postgres://postgres:postgres@localhost:5432/erp_hr_test`.
- CI runners should source this from a secret store and **never**
  echo it back to logs. The helper itself never prints the URL, but
  shell wrappers and `npm` will -- redact in the runner config.

### Provisioning `erp-hr-test`

The repo ships a single idempotent provisioner that ensures the
database exists and runs `prisma migrate deploy` against it. It
re-uses the same safety check as the runtime helper, so a misconfigured
`TEST_DATABASE_URL` is rejected before any DB activity happens.

#### Local setup

1. **Export `TEST_DATABASE_URL`** in your shell or in a `.env.test`
   file you source manually (NOT `.env`, which is loaded by
   `src/server.js` at runtime — see "Hard rules" below):

   ```sh
   export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/erp_hr_test
   ```

2. **Run the provisioner.** It is idempotent — safe to run again
   any time the schema migrations change:

   ```sh
   npm run test:db:prepare
   ```

   The script:
   - Validates `TEST_DATABASE_URL` via `assertSafeTestDatabaseUrl`
     and aborts if the URL looks like a dev / staging / production
     target (see the helper API table above for the full rule set).
   - Calls `createdb` against the host/port/user encoded in the URL.
     If the database already exists, that step is a no-op.
   - Runs `npx prisma migrate deploy` as a **child process** with
     `DATABASE_URL` set to `TEST_DATABASE_URL` for that one
     invocation. The parent shell's `DATABASE_URL` is not modified,
     and `src/lib/prisma.js`'s runtime singleton is never touched.

3. **Run only the perf suites.** Once a perf suite is wired onto the
   helper (see "Reviving the parked perf suite" below), run:

   ```sh
   npm run test:perf
   ```

#### CI setup

No CI workflow is wired in this repo today (no `.github/` directory).
When one is added — or in any external CI system — the perf job
should look roughly like:

```yaml
jobs:
  hr-perf:
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: postgres   # template DB; we create erp_hr_test ourselves
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 5
    env:
      # NEVER hard-code these. Source from the CI secret store, and
      # confirm the database name contains "test" before adding.
      TEST_DATABASE_URL: ${{ secrets.HR_TEST_DATABASE_URL }}
      NODE_ENV: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run test:db:prepare
      - run: npm run test:perf
```

The exact YAML will evolve when a CI workflow lands; the contract
that matters here is:

| Env var | Where | Required for |
| --- | --- | --- |
| `TEST_DATABASE_URL` | CI secret store; never `.env`; never logged | `test:db:prepare`, `test:perf` |
| `NODE_ENV` | Set to `test` for both steps | the helper's safety gate inside the suites |
| `DATABASE_URL` | **Not** required by `test:db:prepare` or `test:perf`; the runtime config is irrelevant to test DB work | runtime only |

The provisioner shells out to `createdb` and `npx prisma migrate
deploy`. The host running the perf job must have a Postgres client
installed (`postgresql-client` on Debian / `libpq` on macOS).
`createdb` failures other than "already exists" abort the script
with a non-zero exit so a misconfigured runner cannot silently fall
through to `test:perf`.

### Hard rules

- **Never point `TEST_DATABASE_URL` at a dev, staging, or production
  database.** The helper will refuse such URLs, but the rule is
  human-level too: a TRUNCATE on the wrong host is irreversible.
- **Never set `TEST_DATABASE_URL` in the same `.env` that
  `src/server.js` loads.** That file is for the runtime singleton.
- **Never commit credentials** for `TEST_DATABASE_URL`. CI secret
  store only.

### Reviving the parked perf suite

When the `erp-hr-test` database is provisioned and
`TEST_DATABASE_URL` is wired through CI, the perf suite owner
should:

- Remove `describe.skip` from `training.performance.test.js`.
- Switch `import app from '../../src/server.js'` to
  `import { createApp } from '../../src/app.js'`.
- Apply `gatewayHeaders(...)` from `tests/helpers/internal-gateway.js`
  to every supertest call.
- Replace the suite's hand-rolled `beforeAll` / `afterAll` cleanup
  with `getTestPrisma()` + `resetTestDatabase()` from
  `tests/helpers/test-db.js`, plus a `disconnectTestPrisma()` in
  `afterAll`.

The file-level header in `training.performance.test.js` tracks the
status of every original blocker.

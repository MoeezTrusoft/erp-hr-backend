#!/usr/bin/env node
// scripts/test-db-provision.js
//
// Idempotent provisioner for the `erp-hr-test` database. Validates
// TEST_DATABASE_URL via the existing helper, ensures the database
// exists, then runs `prisma migrate deploy` against it.
//
// Usage (local):
//
//   export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/erp_hr_test
//   npm run test:db:prepare
//
// Usage (CI):
//
//   - name: Provision erp-hr-test
//     run: npm run test:db:prepare
//     env:
//       TEST_DATABASE_URL: ${{ secrets.HR_TEST_DATABASE_URL }}
//
//   - name: Perf suite
//     run: npm run test:perf
//     env:
//       TEST_DATABASE_URL: ${{ secrets.HR_TEST_DATABASE_URL }}
//       NODE_ENV: test
//
// Safety:
//
//   * Refuses to run if TEST_DATABASE_URL does not pass the safety
//     check in tests/helpers/test-db.js (postgres scheme, name
//     contains "test", neither name nor host contains a prod /
//     staging / live / main / master hint).
//
//   * NEVER mutates the production singleton at src/lib/prisma.js.
//     The `prisma migrate deploy` step is invoked as a child process
//     with DATABASE_URL set to TEST_DATABASE_URL for that one
//     invocation only; the calling shell's env is not altered.
//
//   * `createdb` is invoked with --if-exists semantics emulated by
//     swallowing the "already exists" stderr line. Any other createdb
//     failure aborts the script with a non-zero exit.
//
//   * Never echoes TEST_DATABASE_URL itself to stdout / stderr. Only
//     the parsed database name and (sanitized) host are printed.
import { spawnSync } from 'node:child_process';
import { assertSafeTestDatabaseUrl } from '../tests/helpers/test-db.js';

const fail = (message) => {
    process.stderr.write(`test-db-provision: ${message}\n`);
    process.exit(1);
};

const log = (message) => {
    process.stdout.write(`test-db-provision: ${message}\n`);
};

const rawUrl = process.env.TEST_DATABASE_URL;
if (!rawUrl) {
    fail(
        'TEST_DATABASE_URL is not set. Export it before running this script ' +
        '(see tests/README.md > "Required TEST_DATABASE_URL format").'
    );
}

// Throws on any unsafe URL (prod-named, prod-hosted, non-postgres,
// no "test" in name, etc.). The thrown error never echoes the URL or
// the password -- see tests/helpers/test-db.js for the contract.
let parsed;
try {
    assertSafeTestDatabaseUrl(rawUrl);
    parsed = new URL(rawUrl);
} catch (err) {
    fail(err.message);
}

const dbName = parsed.pathname.replace(/^\//, '').split(/[?#]/)[0].replace(/\/+$/, '');
const host = parsed.hostname || 'localhost';
const port = parsed.port || '5432';
const user = decodeURIComponent(parsed.username || '');
const password = decodeURIComponent(parsed.password || '');

log(`target: db=${dbName} host=${host} port=${port}`);
// Deliberately not echoing user or password. The "user=" line is
// the closest we'll ever come and we still suppress it for safety.

// 1. createdb (idempotent). createdb itself does not support
//    --if-not-exists across all libpq versions, so we handle the
//    "already exists" case by inspecting stderr.
log(`step 1/2: ensure database "${dbName}" exists`);
const createdbEnv = { ...process.env };
if (password) createdbEnv.PGPASSWORD = password;

const createdbResult = spawnSync(
    'createdb',
    [
        '-h', host,
        '-p', port,
        ...(user ? ['-U', user] : []),
        dbName,
    ],
    { env: createdbEnv, encoding: 'utf8' }
);

if (createdbResult.error) {
    if (createdbResult.error.code === 'ENOENT') {
        fail(
            '`createdb` binary not found on PATH. Install the Postgres ' +
            'client tools (e.g. `brew install libpq && brew link --force libpq` on macOS, ' +
            'or `apt-get install postgresql-client` on Debian/Ubuntu).'
        );
    }
    fail(`createdb failed to spawn: ${createdbResult.error.message}`);
}

const createdbStderr = (createdbResult.stderr || '').trim();

if (createdbResult.status === 0) {
    log(`  -> created database "${dbName}"`);
} else if (/already exists/i.test(createdbStderr)) {
    log(`  -> database "${dbName}" already exists (skipping create)`);
} else {
    // Surface stderr but NOT the URL or password (createdb does not
    // print those, but we are defensive anyway).
    fail(`createdb exited ${createdbResult.status}: ${createdbStderr || '(no stderr)'}`);
}

// 2. prisma migrate deploy against the test database. We invoke it
//    as a child process with DATABASE_URL set to TEST_DATABASE_URL
//    for that one call -- this never touches the parent shell's env,
//    and it never reaches src/lib/prisma.js (the runtime singleton).
log('step 2/2: prisma migrate deploy (against the test database)');
const migrateResult = spawnSync(
    'npx',
    ['--no-install', 'prisma', 'migrate', 'deploy'],
    {
        env: { ...process.env, DATABASE_URL: rawUrl },
        stdio: 'inherit',
    }
);

if (migrateResult.error) {
    fail(`prisma migrate deploy failed to spawn: ${migrateResult.error.message}`);
}

if (migrateResult.status !== 0) {
    fail(
        `prisma migrate deploy exited ${migrateResult.status}. ` +
        'Check that the test database is reachable and that schema ' +
        'migrations under prisma/migrations are consistent.'
    );
}

log(`done: erp-hr-test ready at db=${dbName} host=${host} port=${port}`);

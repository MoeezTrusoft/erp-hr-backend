// tests/helpers/test-db.js
//
// Test-database foundation for DB-backed suites (today: just the
// parked training.performance.test.js, tomorrow: any integration
// suite that wants a real DB).
//
// Design constraints:
//
//   * src/lib/prisma.js stays UNCHANGED. The runtime singleton
//     continues to use DATABASE_URL exactly as production does. This
//     helper builds its OWN PrismaClient bound to TEST_DATABASE_URL,
//     so there is no risk of a default `npm test` accidentally
//     pointing the singleton at a live database.
//
//   * The helper refuses to touch any URL that does not clearly
//     identify itself as a test database. The check is conservative:
//     the database name must contain "test" AND must not contain any
//     production/staging hint (prod, production, live, staging, main,
//     master). This is belt-and-braces -- both halves are required.
//
//   * Error messages never echo the URL's password, username, or
//     query string. We only surface the parsed database name (the
//     part after the last "/" of the URL path) and a sanitized host
//     so a misconfigured CI run does not paste credentials into a
//     PR comment.
//
//   * Nothing in this file is imported by any production code path.
//     The default `npm test` and `npm run gate:p1` runs do not
//     require TEST_DATABASE_URL to be set. The helper only blows up
//     when a future DB-backed suite explicitly imports it.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

let cachedClient = null;

// Matches a banned word when it is bounded by anything that is NOT a
// Latin letter -- start/end of string, underscore, hyphen, dot, etc.
// We don't use \b because Postgres database names commonly use
// underscores ("erp_prod_test"), and \b treats _ as a word character
// so \bprod\b would never match "erp_prod_test". The negative class
// also keeps benign substrings like "mainframe" from tripping the rule.
const BANNED_NAME_HINTS = /(?:^|[^A-Za-z])(prod|production|live|staging|main|master)(?:[^A-Za-z]|$)/i;

/**
 * Returns the database name (the path segment after the final "/").
 * Used for both safety checks and for the short, non-leaking name
 * we include in error messages.
 */
const databaseNameOf = (parsed) => {
    // pathname is "/<db>" for a real db URL, or "" / "/" for malformed.
    const raw = (parsed.pathname || '').replace(/^\//, '');
    // Strip query string and trailing slashes defensively.
    return raw.split(/[?#]/)[0].replace(/\/+$/, '');
};

/**
 * Throws if the supplied URL does not look like an isolated HR test
 * database. Public so suites can sanity-check a URL they intend to
 * pass into the helper directly (e.g. when validating CI env in a
 * `beforeAll`).
 *
 * Safety rules:
 *   1. URL must parse.
 *   2. Protocol must be a Postgres scheme (`postgres:` / `postgresql:`).
 *   3. The database name must contain "test" (case-insensitive).
 *   4. Neither the database name nor the hostname may contain any
 *      production/staging hint word.
 */
export const assertSafeTestDatabaseUrl = (url) => {
    if (typeof url !== 'string' || url.length === 0) {
        throw new Error(
            'test-db helper: TEST_DATABASE_URL must be a non-empty string'
        );
    }

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(
            'test-db helper: TEST_DATABASE_URL is not a valid URL (parsing failed; value not echoed)'
        );
    }

    const protocol = (parsed.protocol || '').toLowerCase();
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
        throw new Error(
            'test-db helper: TEST_DATABASE_URL must use the postgres: or postgresql: scheme'
        );
    }

    const dbName = databaseNameOf(parsed);
    if (!dbName) {
        throw new Error(
            'test-db helper: TEST_DATABASE_URL must include a database name (path component)'
        );
    }

    if (!/test/i.test(dbName)) {
        throw new Error(
            `test-db helper: refusing TEST_DATABASE_URL whose database name does not contain "test" (db=${dbName})`
        );
    }

    if (BANNED_NAME_HINTS.test(dbName)) {
        throw new Error(
            `test-db helper: refusing TEST_DATABASE_URL whose database name looks like a production/staging target (db=${dbName})`
        );
    }

    if (BANNED_NAME_HINTS.test(parsed.hostname || '')) {
        throw new Error(
            `test-db helper: refusing TEST_DATABASE_URL whose host looks like a production/staging target (host=${parsed.hostname})`
        );
    }

    return { dbName, host: parsed.hostname || 'unknown' };
};

/**
 * Returns the safe TEST_DATABASE_URL or throws. NODE_ENV must be
 * "test" so the helper cannot be invoked from a dev / prod runtime
 * by accident (e.g. if a future commit imports it from src/).
 */
export const requireTestDatabaseUrl = () => {
    if (process.env.NODE_ENV !== 'test') {
        throw new Error(
            'test-db helper: NODE_ENV must be "test" before requireTestDatabaseUrl() can be called ' +
            '(Jest sets this automatically; never invoke from production code)'
        );
    }
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
        throw new Error(
            'test-db helper: TEST_DATABASE_URL must be set on process.env to use the DB-backed test helper ' +
            '(see tests/README.md for the required format)'
        );
    }
    // assertSafeTestDatabaseUrl throws on any safety violation; the
    // caller never receives an unsafe URL.
    assertSafeTestDatabaseUrl(url);
    return url;
};

/**
 * Returns a cached PrismaClient bound to TEST_DATABASE_URL. The
 * singleton is scoped to this helper -- it is intentionally NOT the
 * same instance as `src/lib/prisma.js`, so the runtime singleton
 * stays bound to DATABASE_URL exactly as production does.
 */
export const getTestPrisma = () => {
    if (cachedClient) return cachedClient;
    const url = requireTestDatabaseUrl();
    cachedClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
        datasourceUrl: url,
        log: ['warn', 'error'],
    });
    return cachedClient;
};

/**
 * Disconnects and clears the cached test client. Suites should call
 * this in `afterAll` so Jest can exit cleanly.
 */
export const disconnectTestPrisma = async () => {
    if (!cachedClient) return;
    try {
        await cachedClient.$disconnect();
    } finally {
        cachedClient = null;
    }
};

/**
 * TRUNCATE-based isolation for DB-backed suites.
 *
 * Why not transactional rollback: HR services import the
 * module-singleton prisma at `src/lib/prisma.js` directly. There is
 * no clean way to thread a `prisma.$transaction` callback's `tx`
 * scope through the existing service surface without refactoring
 * every service. Refusing to do that refactor in this lane -- we
 * fall back to TRUNCATE between tests, which is what the perf
 * harness's existing `afterAll` already does (just with `deleteMany`).
 *
 * The default table list matches the parked
 * training.performance.test.js's `afterAll` cleanup. Callers can
 * pass their own list to extend coverage.
 *
 * Tables are listed in foreign-key-safe order. RESTART IDENTITY +
 * CASCADE handle sequence resets and any FKs we missed.
 */
const DEFAULT_TABLES = [
    'TrainingEnrollment',
    'TrainingCourse',
    'TrainingCategory',
    'Employee',
];

/**
 * For a real run this issues a single TRUNCATE against the supplied
 * tables on the test database. For typo safety it quotes every
 * identifier and only accepts table names matching a strict allowlist
 * pattern. It will REFUSE to run if the connection is not bound to a
 * safe TEST_DATABASE_URL.
 */
export const resetTestDatabase = async ({ tables = DEFAULT_TABLES } = {}) => {
    // Re-validate the URL on every call. Cheap, and the only way to
    // catch a TEST_DATABASE_URL that was mutated mid-run.
    requireTestDatabaseUrl();

    if (!Array.isArray(tables) || tables.length === 0) {
        throw new Error('test-db helper: resetTestDatabase requires a non-empty tables array');
    }
    for (const t of tables) {
        if (typeof t !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
            // Reject anything that does not look like a Prisma model
            // table identifier; never let an arbitrary string reach
            // executeRawUnsafe.
            throw new Error(`test-db helper: resetTestDatabase refused unsafe table name (got "${t}")`);
        }
    }

    const prisma = getTestPrisma();
    const quoted = tables.map((t) => `"${t}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
};

/**
 * Re-exports for unit tests of this helper. Internal use only.
 */
export const __testables = { databaseNameOf, BANNED_NAME_HINTS };

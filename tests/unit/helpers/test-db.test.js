// tests/unit/helpers/test-db.test.js
//
// Contract tests for tests/helpers/test-db.js. These run under the
// default `npm test` invocation and must NOT require a real database
// connection -- the @prisma/client constructor is mocked, and the
// helper's safety checks all run on string inputs before any client
// is constructed.
import { jest, describe, test, expect, beforeEach, afterAll } from '@jest/globals';

// Mock @prisma/client so calling getTestPrisma() does not try to
// open a connection. The mock captures the constructor args so we
// can assert the helper passes the right datasourceUrl through.
const mockPrismaConstructor = jest.fn();
const mockDisconnect = jest.fn().mockResolvedValue(undefined);
const mockExecuteRawUnsafe = jest.fn().mockResolvedValue(0);

jest.unstable_mockModule('@prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation((opts) => {
        mockPrismaConstructor(opts);
        return {
            $disconnect: mockDisconnect,
            $executeRawUnsafe: mockExecuteRawUnsafe,
        };
    }),
}));

const {
    assertSafeTestDatabaseUrl,
    requireTestDatabaseUrl,
    getTestPrisma,
    disconnectTestPrisma,
    resetTestDatabase,
} = await import('../../helpers/test-db.js');

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_TEST_URL = process.env.TEST_DATABASE_URL;

const SAFE_URL = 'postgresql://hr:secretpw@localhost:5432/erp_hr_test';
const PASSWORD_IN_URL = 'super-secret-password-do-not-log';

describe('tests/helpers/test-db.js', () => {
    beforeEach(async () => {
        // Disconnect FIRST so the helper's $disconnect call from any
        // prior test does not show up in the next test's mock counters.
        await disconnectTestPrisma();
        mockPrismaConstructor.mockClear();
        mockDisconnect.mockClear();
        mockExecuteRawUnsafe.mockClear();
        process.env.NODE_ENV = 'test';
        delete process.env.TEST_DATABASE_URL;
    });

    afterAll(async () => {
        await disconnectTestPrisma();
        if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
        if (ORIGINAL_TEST_URL === undefined) delete process.env.TEST_DATABASE_URL;
        else process.env.TEST_DATABASE_URL = ORIGINAL_TEST_URL;
    });

    describe('assertSafeTestDatabaseUrl()', () => {
        test('accepts a postgres URL whose database name contains "test"', () => {
            expect(() => assertSafeTestDatabaseUrl(SAFE_URL)).not.toThrow();
            expect(() =>
                assertSafeTestDatabaseUrl('postgres://u:p@h:5432/erp_hr_test')
            ).not.toThrow();
            expect(() =>
                assertSafeTestDatabaseUrl('postgresql://u:p@h:5432/hr_test_ci')
            ).not.toThrow();
        });

        test('rejects URLs whose database name does not contain "test"', () => {
            expect(() =>
                assertSafeTestDatabaseUrl('postgresql://u:p@host/erp_hr')
            ).toThrow(/does not contain "test"/);
        });

        test.each([
            ['postgresql://u:p@host/erp_prod_test', /production\/staging target/],
            ['postgresql://u:p@host/production_test', /production\/staging target/],
            ['postgresql://u:p@host/erp_hr_live_test', /production\/staging target/],
            ['postgresql://u:p@host/erp_hr_staging_test', /production\/staging target/],
            ['postgresql://u:p@host/main_test', /production\/staging target/],
        ])('rejects database names containing prod/staging hints (%s)', (url, pattern) => {
            expect(() => assertSafeTestDatabaseUrl(url)).toThrow(pattern);
        });

        test('rejects URLs whose hostname looks like production/staging', () => {
            expect(() =>
                assertSafeTestDatabaseUrl(
                    'postgresql://u:p@db-production.internal/erp_hr_test'
                )
            ).toThrow(/host looks like a production\/staging target/);
        });

        test('rejects non-postgres schemes', () => {
            expect(() =>
                assertSafeTestDatabaseUrl('mysql://u:p@host/erp_hr_test')
            ).toThrow(/postgres: or postgresql: scheme/);
        });

        test('rejects empty / non-string / unparseable URLs', () => {
            expect(() => assertSafeTestDatabaseUrl('')).toThrow(/non-empty string/);
            expect(() => assertSafeTestDatabaseUrl(undefined)).toThrow(/non-empty string/);
            expect(() => assertSafeTestDatabaseUrl(42)).toThrow(/non-empty string/);
            expect(() => assertSafeTestDatabaseUrl('not a url')).toThrow(/not a valid URL/);
        });

        test('rejects URLs with no database name path', () => {
            expect(() =>
                assertSafeTestDatabaseUrl('postgresql://u:p@host:5432/')
            ).toThrow(/must include a database name/);
        });

        test('error messages do not echo the URL password or full URL', () => {
            const leaky = `postgresql://hr_admin:${PASSWORD_IN_URL}@db-production.internal/erp_hr_prod`;
            try {
                assertSafeTestDatabaseUrl(leaky);
                throw new Error('expected assertSafeTestDatabaseUrl to throw');
            } catch (err) {
                expect(err.message).not.toContain(PASSWORD_IN_URL);
                expect(err.message).not.toContain('hr_admin');
                expect(err.message).not.toContain(leaky);
            }
        });
    });

    describe('requireTestDatabaseUrl()', () => {
        test('returns the URL when NODE_ENV=test and TEST_DATABASE_URL is safe', () => {
            process.env.TEST_DATABASE_URL = SAFE_URL;
            expect(requireTestDatabaseUrl()).toBe(SAFE_URL);
        });

        test('throws if NODE_ENV is not "test"', () => {
            process.env.NODE_ENV = 'development';
            process.env.TEST_DATABASE_URL = SAFE_URL;
            expect(() => requireTestDatabaseUrl()).toThrow(/NODE_ENV must be "test"/);
        });

        test('throws if TEST_DATABASE_URL is unset', () => {
            // beforeEach deletes it; do not re-set.
            expect(() => requireTestDatabaseUrl()).toThrow(/TEST_DATABASE_URL must be set/);
        });

        test('throws (via assertSafe) if TEST_DATABASE_URL is unsafe', () => {
            process.env.TEST_DATABASE_URL = 'postgresql://u:p@host/erp_hr_prod';
            expect(() => requireTestDatabaseUrl()).toThrow(/does not contain "test"/);
        });

        test('thrown errors never include the password or full URL', () => {
            process.env.TEST_DATABASE_URL = `postgresql://hr:${PASSWORD_IN_URL}@h/erp_hr`;
            try {
                requireTestDatabaseUrl();
                throw new Error('expected requireTestDatabaseUrl to throw');
            } catch (err) {
                expect(err.message).not.toContain(PASSWORD_IN_URL);
                expect(err.message).not.toContain(process.env.TEST_DATABASE_URL);
            }
        });
    });

    describe('getTestPrisma() / disconnectTestPrisma()', () => {
        test('constructs PrismaClient with datasourceUrl from TEST_DATABASE_URL', () => {
            process.env.TEST_DATABASE_URL = SAFE_URL;

            const prisma = getTestPrisma();

            expect(prisma).toBeDefined();
            expect(mockPrismaConstructor).toHaveBeenCalledTimes(1);
            expect(mockPrismaConstructor).toHaveBeenCalledWith(
                expect.objectContaining({ datasourceUrl: SAFE_URL })
            );
        });

        test('returns the same instance on repeat calls (cached singleton)', () => {
            process.env.TEST_DATABASE_URL = SAFE_URL;

            const a = getTestPrisma();
            const b = getTestPrisma();

            expect(a).toBe(b);
            expect(mockPrismaConstructor).toHaveBeenCalledTimes(1);
        });

        test('disconnectTestPrisma() calls $disconnect and clears the cache', async () => {
            process.env.TEST_DATABASE_URL = SAFE_URL;

            getTestPrisma();
            await disconnectTestPrisma();

            expect(mockDisconnect).toHaveBeenCalledTimes(1);

            // Next getTestPrisma() builds a fresh client.
            getTestPrisma();
            expect(mockPrismaConstructor).toHaveBeenCalledTimes(2);
        });

        test('disconnectTestPrisma() with no cached client is a no-op', async () => {
            await expect(disconnectTestPrisma()).resolves.toBeUndefined();
            expect(mockDisconnect).not.toHaveBeenCalled();
        });

        test('throws (before constructing the client) if TEST_DATABASE_URL is unsafe', () => {
            process.env.TEST_DATABASE_URL = 'postgresql://u:p@host/erp_prod';
            expect(() => getTestPrisma()).toThrow(/test/);
            expect(mockPrismaConstructor).not.toHaveBeenCalled();
        });
    });

    describe('resetTestDatabase()', () => {
        test('TRUNCATEs the default tables in the test database', async () => {
            process.env.TEST_DATABASE_URL = SAFE_URL;

            await resetTestDatabase();

            expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(1);
            const sql = mockExecuteRawUnsafe.mock.calls[0][0];
            expect(sql).toMatch(/^TRUNCATE TABLE /);
            expect(sql).toContain('"TrainingEnrollment"');
            expect(sql).toContain('"TrainingCourse"');
            expect(sql).toContain('"TrainingCategory"');
            expect(sql).toContain('"Employee"');
            expect(sql).toContain('RESTART IDENTITY CASCADE');
        });

        test('accepts a caller-supplied tables list', async () => {
            process.env.TEST_DATABASE_URL = SAFE_URL;

            await resetTestDatabase({ tables: ['TrainingCourse'] });

            const sql = mockExecuteRawUnsafe.mock.calls[0][0];
            expect(sql).toBe('TRUNCATE TABLE "TrainingCourse" RESTART IDENTITY CASCADE');
        });

        test('refuses unsafe table identifiers and never reaches the DB', async () => {
            process.env.TEST_DATABASE_URL = SAFE_URL;

            await expect(
                resetTestDatabase({ tables: ['users; DROP TABLE users; --'] })
            ).rejects.toThrow(/refused unsafe table name/);

            expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
        });

        test('refuses an empty tables array', async () => {
            process.env.TEST_DATABASE_URL = SAFE_URL;

            await expect(
                resetTestDatabase({ tables: [] })
            ).rejects.toThrow(/non-empty tables array/);
        });

        test('throws if TEST_DATABASE_URL was unset between calls', async () => {
            process.env.TEST_DATABASE_URL = SAFE_URL;
            await resetTestDatabase(); // primes the client

            delete process.env.TEST_DATABASE_URL;

            await expect(resetTestDatabase()).rejects.toThrow(
                /TEST_DATABASE_URL must be set/
            );
        });
    });

    describe('isolation from the runtime singleton', () => {
        test('does not import or touch src/lib/prisma.js', async () => {
            // Sanity check: the helper module must not pull in the
            // production singleton, otherwise a stray import in a
            // future commit could route a service call to the test
            // database. We assert this by inspecting the helper
            // module's source for the forbidden import line. This
            // is admittedly a textual check, but it catches the
            // exact regression we care about ("someone added
            // `import prisma from '../../src/lib/prisma.js'` here").
            const fs = await import('node:fs/promises');
            const url = await import('node:url');
            const path = await import('node:path');
            const here = path.dirname(url.fileURLToPath(import.meta.url));
            const helperPath = path.resolve(here, '../../helpers/test-db.js');
            const source = await fs.readFile(helperPath, 'utf8');

            expect(source).not.toMatch(/from\s+['"][^'"]*src\/lib\/prisma['"]/);
            expect(source).not.toMatch(/from\s+['"][^'"]*src\/config\/prisma['"]/);
        });
    });

    describe('default npm test runs without TEST_DATABASE_URL', () => {
        test('the helper module loads cleanly even when the env var is unset', () => {
            // beforeEach deletes TEST_DATABASE_URL, and this file
            // executed top-level `await import(...)` of the helper
            // BEFORE any test ran. The fact that the import did not
            // throw is the assertion. We just re-confirm here that
            // requireTestDatabaseUrl is what enforces the rule, not
            // the import itself.
            expect(typeof requireTestDatabaseUrl).toBe('function');
            expect(typeof getTestPrisma).toBe('function');
            expect(() => requireTestDatabaseUrl()).toThrow(
                /TEST_DATABASE_URL must be set/
            );
        });
    });
});

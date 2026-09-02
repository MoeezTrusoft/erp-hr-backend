// HR-ATT-DEVICE-INTAKE-03 — the async-local context must still be active when a
// Prisma query actually EXECUTES, not merely when it is constructed.
//
// Prisma client methods return a lazy PrismaPromise: nothing runs until it is
// awaited. Writing
//     await mcpCtx.run({ system: true }, () => prisma.x.createMany(...))
// hands the un-executed query back out of mcpCtx.run, the AsyncLocalStorage
// store unwinds, and the query then runs with NO store — tenantScope.js denies
// it with "HR-4030: AttendanceDevicePunch.createMany ran without a tenant
// context". This shipped to prod and every ingest returned 403.
//
// HR-ATT-DEVICE-INTAKE-02's mocks could not catch it: they returned an eager
// promise and tracked contexts in an array rather than a real store. This suite
// uses the real AsyncLocalStorage and a lazy thenable that samples the store at
// execution time, which is what production actually does.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';

const ENV_TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const OTHER_TENANT = '8ff0533b-0000-4000-8000-000000000001';

const EMPLOYEES = [
    { id: 11, biometric_id: '3113', employee_code: 'EMP227', tenant_id: ENV_TENANT },
    { id: 22, biometric_id: '1021', employee_code: 'EMP180', tenant_id: OTHER_TENANT },
];

// The real thing, not a stand-in: only this reproduces store unwinding.
const als = new AsyncLocalStorage();
// Store sampled at EXECUTION time for each call, keyed by operation.
const executionStores = { createMany: undefined, findMany: undefined, rollup: [] };

/**
 * Mimics a PrismaPromise: inert until awaited, and it samples the ambient store
 * at that moment. Also mimics tenantScope.js — no store means HR-4030.
 */
function lazyQuery(op, produce) {
    return {
        then(resolve, reject) {
            const store = als.getStore();
            executionStores[op] = store;
            if (!store) {
                return reject(
                    Object.assign(
                        new Error(
                            `HR-4030: AttendanceDevicePunch.${op} ran without a tenant context ` +
                            `(deny-by-default).`,
                        ),
                        { status: 403, code: 'HR-4030' },
                    ),
                );
            }
            return Promise.resolve(produce(store)).then(resolve, reject);
        },
    };
}

const prismaMock = {
    employee: {
        findMany: jest.fn(({ where }) =>
            lazyQuery('findMany', (store) => {
                const ids = where.OR.flatMap((c) => c.biometric_id?.in ?? c.employee_code?.in ?? []);
                const visible = store.system
                    ? EMPLOYEES
                    : EMPLOYEES.filter((e) => e.tenant_id === store.user?.tenantId);
                return visible.filter(
                    (e) => ids.includes(e.biometric_id) || ids.includes(e.employee_code),
                );
            }),
        ),
    },
    attendanceDevicePunch: {
        createMany: jest.fn((args) => lazyQuery('createMany', () => ({ count: args.data.length }))),
    },
};

const syncMock = jest.fn(async () => {
    executionStores.rollup.push(als.getStore());
    return { created: 1, updated: 0 };
});

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/mcp/context.js', () => ({ mcpCtx: als }));
jest.unstable_mockModule('../../src/services/attendance.device.service.js', () => ({
    syncAttendanceFromPunches: syncMock,
}));
// HR-ATT-CUTOVER-01: roll-up now runs through the evaluator-backed writer; the
// context property under test is the same.
jest.unstable_mockModule('../../src/services/attendanceWriter.service.js', () => ({
    applyEvaluatedShiftsForDays: syncMock,
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { ingestDevicePunches } = await import('../../src/services/attendance.device-intake.service.js');

const ROWS = [
    '3113\t2026-08-14 09:02:11\t0\t15\t0',
    '1021\t2026-08-14 11:04:57\t0\t15\t0',
];

beforeEach(() => {
    executionStores.createMany = undefined;
    executionStores.findMany = undefined;
    executionStores.rollup = [];
    jest.clearAllMocks();
});

describe('HR-ATT-DEVICE-INTAKE-03 async-local context survives lazy queries', () => {
    it('ingests without HR-4030 (the whole batch, end to end)', async () => {
        const summary = await ingestDevicePunches({
            sn: 'TTQ5261300360',
            rows: ROWS,
            tenantId: ENV_TENANT,
        });

        expect(summary.rawStored).toBe(2);
        expect(summary.resolved).toBe(2);
    });

    it('executes the raw-punch write under SYSTEM context, since rows span tenants', async () => {
        await ingestDevicePunches({ sn: 'TTQ5261300360', rows: ROWS, tenantId: ENV_TENANT });

        expect(executionStores.createMany).toBeDefined();   // undefined == the HR-4030 bug
        expect(executionStores.createMany.system).toBe(true);
    });

    it('executes employee resolution under SYSTEM context', async () => {
        await ingestDevicePunches({ sn: 'TTQ5261300360', rows: ROWS, tenantId: ENV_TENANT });

        expect(executionStores.findMany).toBeDefined();
        expect(executionStores.findMany.system).toBe(true);
    });

    it('executes each roll-up under its own tenant context', async () => {
        await ingestDevicePunches({ sn: 'TTQ5261300360', rows: ROWS, tenantId: ENV_TENANT });

        expect(executionStores.rollup).toHaveLength(2);
        expect(new Set(executionStores.rollup.map((s) => s?.user?.tenantId))).toEqual(
            new Set([ENV_TENANT, OTHER_TENANT]),
        );
    });
});

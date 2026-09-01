// HR-ATT-DEVICE-INTAKE-02 — one physical device serves the whole fleet, so a
// batch spans tenants. Regression: buildEmployeeMap ran inside
// mcpCtx.run({user:{tenantId}}) with tenantId from HR_ATTENDANCE_INTAKE_TENANT_ID,
// so RLS scoped employee resolution to that ONE tenant. On prod that resolved
// ~15% of punches (Trusoft only); the other 50 employees stored unresolved and
// never reached the daily Attendance table. Every row was also stamped with the
// env tenant regardless of who actually punched.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const ENV_TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const OTHER_TENANT = '8ff0533b-0000-4000-8000-000000000001';

// Employees deliberately in two different tenants, mirroring the real roster.
const EMPLOYEES = [
    { id: 11, biometric_id: '3113', employee_code: 'EMP227', tenant_id: ENV_TENANT },
    { id: 22, biometric_id: '1021', employee_code: 'EMP180', tenant_id: OTHER_TENANT },
];

// unstable_mockModule factories are not hoisted, so plain consts are enough.
const createManyCalls = [];
const mcpCtxMock = {
    contexts: [],
    run: jest.fn(async (ctx, fn) => {
        mcpCtxMock.contexts.push(ctx);
        return fn();
    }),
};
const prismaMock = {
    person: { findMany: jest.fn(async () => []) },
    employee: { findMany: jest.fn(), findFirst: jest.fn(async () => null) },
    attendanceDevicePunch: { createMany: jest.fn() },
};
const syncMock = jest.fn(async () => ({ created: 1, updated: 0 }));

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/mcp/context.js', () => ({ mcpCtx: mcpCtxMock }));
jest.unstable_mockModule('../../src/services/attendance.device.service.js', () => ({
    syncAttendanceFromPunches: syncMock,
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { ingestDevicePunches } = await import('../../src/services/attendance.device-intake.service.js');

// Stands in for RLS: findMany only returns employees visible in the ambient
// context. A user-scoped context sees one tenant; SYSTEM sees everything.
function rlsAwareFindMany() {
    prismaMock.employee.findMany.mockImplementation(async ({ where }) => {
        const ids = where.OR.flatMap((c) => c.biometric_id?.in ?? c.employee_code?.in ?? []);
        const ctx = mcpCtxMock.contexts[mcpCtxMock.contexts.length - 1];
        const visible = ctx?.system
            ? EMPLOYEES
            : EMPLOYEES.filter((e) => e.tenant_id === ctx?.user?.tenantId);
        return visible.filter((e) => ids.includes(e.biometric_id) || ids.includes(e.employee_code));
    });
}

beforeEach(() => {
    createManyCalls.length = 0;
    mcpCtxMock.contexts.length = 0;
    jest.clearAllMocks();
    prismaMock.person.findMany.mockResolvedValue([]);
    prismaMock.employee.findFirst.mockResolvedValue(null);
    prismaMock.attendanceDevicePunch.createMany.mockImplementation(async (args) => {
        createManyCalls.push(args);
        return { count: args.data.length };
    });
    rlsAwareFindMany();
});

const ROWS = [
    '3113\t2026-08-14 09:02:11\t0\t15\t0', // ENV_TENANT employee
    '1021\t2026-08-14 11:04:57\t0\t15\t0', // OTHER_TENANT employee
];

describe('HR-ATT-DEVICE-INTAKE-02 fleet-wide resolution', () => {
    it('resolves employees from every tenant, not just the intake tenant', async () => {
        const summary = await ingestDevicePunches({ sn: 'TTQ5261300360', rows: ROWS, tenantId: ENV_TENANT });

        expect(summary.resolved).toBe(2);
        expect(summary.unresolved).toBe(0);
    });

    it('stamps each punch with its own employee tenant, not the env tenant', async () => {
        await ingestDevicePunches({ sn: 'TTQ5261300360', rows: ROWS, tenantId: ENV_TENANT });

        const stamped = createManyCalls[0].data.map((r) => [r.deviceUserId, r.employeeId, r.tenantId]);
        expect(stamped).toEqual([
            ['3113', 11, ENV_TENANT],
            ['1021', 22, OTHER_TENANT],
        ]);
    });

    it('falls back to the env tenant only for enrolment ids matching nobody', async () => {
        const summary = await ingestDevicePunches({
            sn: 'TTQ5261300360',
            rows: ['9999\t2026-08-14 09:02:11\t0\t15\t0'],
            tenantId: ENV_TENANT,
        });

        expect(summary.unresolved).toBe(1);
        expect(createManyCalls[0].data[0]).toMatchObject({ employeeId: null, tenantId: ENV_TENANT });
    });

    it('rolls up once per tenant present in the batch', async () => {
        await ingestDevicePunches({ sn: 'TTQ5261300360', rows: ROWS, tenantId: ENV_TENANT });

        expect(syncMock).toHaveBeenCalledTimes(2);
        const rollupTenants = mcpCtxMock.contexts.filter((c) => c?.user?.tenantId).map((c) => c.user.tenantId);
        expect(new Set(rollupTenants)).toEqual(new Set([ENV_TENANT, OTHER_TENANT]));
    });

    it('survives an environment with no Person table (P2021)', async () => {
        const { Prisma } = await import('@prisma/client');
        const err = new Prisma.PrismaClientKnownRequestError('table does not exist', {
            code: 'P2021',
            clientVersion: 'test',
        });
        prismaMock.person.findMany.mockRejectedValueOnce(err);

        const summary = await ingestDevicePunches({ sn: 'TTQ5261300360', rows: ROWS, tenantId: ENV_TENANT });

        expect(summary.resolved).toBe(2);
    });

    it('does not swallow unexpected Person lookup failures', async () => {
        prismaMock.person.findMany.mockRejectedValueOnce(new Error('connection reset'));

        await expect(
            ingestDevicePunches({ sn: 'TTQ5261300360', rows: ROWS, tenantId: ENV_TENANT }),
        ).rejects.toThrow('connection reset');
    });
});

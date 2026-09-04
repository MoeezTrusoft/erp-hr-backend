// HR-ATT-ORPHAN-RESOLVE-01 — punches that arrived before the employee carried
// the device id.
//
// The intake resolves deviceUserId -> employee at write time only. An id that
// matches nobody stores with employeeId null AND, per intake.service:135,
// `tenantId: hit?.tenantId ?? tenantId` — the DEVICE's fallback tenant. Once HR
// enrols the person, nothing ever goes back for those rows: they sit orphaned
// forever and never reach the daily Attendance table.
//
// On prod that is 17 punches across 11 employees who are already correctly
// enrolled today.
//
// The trap this test exists to pin: re-linking must fix BOTH columns. Every
// orphan is stamped with the device's tenant (Trusoft), but the employees span
// tenants — EMP161 is EMG. Setting employeeId alone leaves an EMG employee's
// punch stamped Trusoft, where RLS hides it from his own tenant and the roll-up
// that follows silently reads zero rows.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const DEVICE_TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523'; // Trusoft, the fallback
const EMG_TENANT = '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73';

const EMPLOYEES = [
    { id: 161, biometric_id: '706', employee_code: 'EMP161', tenant_id: EMG_TENANT },
    { id: 188, biometric_id: '1008', employee_code: 'EMP188', tenant_id: DEVICE_TENANT },
];

// Orphans as they actually sit in the table: employeeId null, tenantId = device.
const ORPHANS = [
    { id: 1, deviceUserId: '706', punchedAt: new Date('2026-09-01T05:02:00Z'), tenantId: DEVICE_TENANT, employeeId: null },
    { id: 2, deviceUserId: '1008', punchedAt: new Date('2026-09-01T04:31:00Z'), tenantId: DEVICE_TENANT, employeeId: null },
    { id: 3, deviceUserId: '3120', punchedAt: new Date('2026-07-28T05:00:00Z'), tenantId: DEVICE_TENANT, employeeId: null },
];

const mcpCtxMock = {
    contexts: [],
    run: jest.fn(async (ctx, fn) => {
        mcpCtxMock.contexts.push(ctx);
        return fn();
    }),
};
const updateCalls = [];
const prismaMock = {
    employee: { findMany: jest.fn() },
    attendanceDevicePunch: {
        findMany: jest.fn(async () => ORPHANS),
        update: jest.fn(async (args) => {
            updateCalls.push(args);
            return args;
        }),
    },
};
const rollupMock = jest.fn(async () => ({ created: 1, updated: 0 }));

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/mcp/context.js', () => ({ mcpCtx: mcpCtxMock }));
jest.unstable_mockModule('../../src/services/attendanceWriter.service.js', () => ({
    applyEvaluatedShiftsForDays: rollupMock,
}));
jest.unstable_mockModule('../../src/services/attendance.device.service.js', () => ({
    syncAttendanceFromPunches: jest.fn(async () => ({})),
}));
// HR-ATT-DEVICE-ENROLMENT-01 — re-resolve now consults dated enrolments first.
// This scenario has none, so the resolver returns undefined and the
// biometric_id fallback under test behaves exactly as before.
jest.unstable_mockModule('../../src/services/deviceEnrolment.service.js', () => ({
    buildEnrolmentResolver: jest.fn(async () => () => undefined),
    resolveEnrolmentAt: jest.fn(async () => new Map()),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { resolveOrphanPunches } = await import('../../src/services/attendance.device-intake.service.js');

beforeEach(() => {
    updateCalls.length = 0;
    mcpCtxMock.contexts.length = 0;
    jest.clearAllMocks();
    prismaMock.attendanceDevicePunch.findMany.mockResolvedValue(ORPHANS);
    prismaMock.employee.findMany.mockImplementation(async ({ where }) => {
        const ids = where.OR.flatMap((c) => c.biometric_id?.in ?? c.employee_code?.in ?? []);
        return EMPLOYEES.filter((e) => ids.includes(e.biometric_id) || ids.includes(e.employee_code));
    });
});

describe('HR-ATT-ORPHAN-RESOLVE-01 re-resolve orphaned punches', () => {
    it('links orphans whose device id now matches an employee', async () => {
        const summary = await resolveOrphanPunches({ dryRun: false });

        expect(summary.resolved).toBe(2);
        expect(updateCalls.map((c) => c.where.id).sort()).toEqual([1, 2]);
    });

    it('moves the punch to the EMPLOYEE tenant, not the device tenant', async () => {
        // The defect this guards: EMP161 is EMG but every orphan is stamped
        // Trusoft. employeeId alone leaves the row invisible to its own tenant.
        await resolveOrphanPunches({ dryRun: false });

        const emg = updateCalls.find((c) => c.where.id === 1);
        expect(emg.data).toEqual({ employeeId: 161, tenantId: EMG_TENANT });
    });

    it('leaves the tenant alone when it is already correct', async () => {
        await resolveOrphanPunches({ dryRun: false });

        const same = updateCalls.find((c) => c.where.id === 2);
        expect(same.data).toEqual({ employeeId: 188, tenantId: DEVICE_TENANT });
    });

    it('leaves genuinely unmatched orphans untouched', async () => {
        const summary = await resolveOrphanPunches({ dryRun: false });

        expect(summary.stillUnresolved).toEqual(['3120']);
        expect(updateCalls.some((c) => c.where.id === 3)).toBe(false);
    });

    it('rolls up the affected days so Attendance rows actually appear', async () => {
        // Re-linking a punch does not by itself create attendance. Without this
        // the fix looks green and the timesheet stays empty.
        await resolveOrphanPunches({ dryRun: false });

        expect(rollupMock).toHaveBeenCalled();
        const tenants = rollupMock.mock.calls.map((c) => c[0].tenantId);
        expect(new Set(tenants)).toEqual(new Set([EMG_TENANT, DEVICE_TENANT]));
    });

    it('writes nothing when dryRun', async () => {
        const summary = await resolveOrphanPunches({ dryRun: true });

        expect(summary.resolved).toBe(2);
        expect(updateCalls).toHaveLength(0);
        expect(rollupMock).not.toHaveBeenCalled();
    });

    it('resolves under SYSTEM context — orphans span tenants', async () => {
        await resolveOrphanPunches({ dryRun: true });

        expect(mcpCtxMock.contexts.some((c) => c?.system)).toBe(true);
    });
});

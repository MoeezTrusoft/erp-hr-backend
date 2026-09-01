// HR-ATT-POLICY-01 — Payroll Setup attendance config services.
//
// These three services guard money: their validation is what stops a typo in
// Payroll Setup from turning into a salary deduction. The cases below are the
// ones that would actually hurt, not exhaustive field coverage.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const prismaMock = {
    attendancePolicyConfig: { findUnique: jest.fn(), upsert: jest.fn(async ({ create, update }) => ({ id: 1, ...create, ...update })) },
    attendanceDeductionRule: { findMany: jest.fn(async () => []), upsert: jest.fn(async ({ create }) => ({ id: 1, ...create })) },
    attendanceApprovalLevel: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null), upsert: jest.fn(async ({ create }) => ({ id: 1, ...create })), delete: jest.fn() },
    employee: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    // Runs the callback against the same mock client the service would see.
    tenantTransaction: jest.fn(async (_client, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const policy = await import('../../src/services/attendancePolicyConfig.service.js');
const deductions = await import('../../src/services/attendanceDeductionRule.service.js');
const approvals = await import('../../src/services/attendanceApprovalLevel.service.js');

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.attendancePolicyConfig.findUnique.mockResolvedValue(null);
    prismaMock.attendanceApprovalLevel.findUnique.mockResolvedValue(null);
    prismaMock.employee.findUnique.mockResolvedValue(null);
    prismaMock.attendanceDeductionRule.findMany.mockResolvedValue([]);
});

describe('HR-ATT-POLICY-01 attendance policy config', () => {
    it('falls back to defaults when the tenant has no row', async () => {
        const row = await policy.getAttendancePolicy({ tenantId: TENANT });

        expect(row.id).toBeNull();          // id:null distinguishes unsaved from saved-as-default
        expect(row.halfDayAfterMinutes).toBe(30);
        expect(row.shiftGapHours).toBe(11);
    });

    it('rejects a half-day band stricter than the full-day band', async () => {
        // Inverted bands would make a half day harder to earn than a full day.
        await expect(
            policy.updateAttendancePolicy({ tenantId: TENANT, halfDayMinPercent: 95, fullDayMinPercent: 90 }),
        ).rejects.toThrow('halfDayMinPercent must be <= fullDayMinPercent');
    });

    it('catches inversion against the STORED row, not just the payload', async () => {
        prismaMock.attendancePolicyConfig.findUnique.mockResolvedValue({
            ...policy.defaultAttendancePolicy(), id: 7, fullDayMinPercent: 60,
        });

        // Payload alone looks fine; only the stored full-day value reveals it.
        await expect(
            policy.updateAttendancePolicy({ tenantId: TENANT, halfDayMinPercent: 80 }),
        ).rejects.toThrow('halfDayMinPercent must be <= fullDayMinPercent');
    });

    it('rejects a session gap that would split or swallow a shift', async () => {
        await expect(policy.updateAttendancePolicy({ tenantId: TENANT, shiftGapHours: 1 })).rejects.toThrow();
        await expect(policy.updateAttendancePolicy({ tenantId: TENANT, shiftGapHours: 30 })).rejects.toThrow();
    });

    it('rejects a malformed shift start', async () => {
        await expect(policy.updateAttendancePolicy({ tenantId: TENANT, defaultShiftStart: '9am' })).rejects.toThrow('HH:MM');
        await expect(policy.updateAttendancePolicy({ tenantId: TENANT, defaultShiftStart: '24:00' })).rejects.toThrow('HH:MM');
    });

    it('writes as DRAFT so the payroll publish step owns promotion', async () => {
        await policy.updateAttendancePolicy({ tenantId: TENANT, graceMinutes: 15 });

        const call = prismaMock.attendancePolicyConfig.upsert.mock.calls[0][0];
        expect(call.create.status).toBe('DRAFT');
        expect(call.update.status).toBe('DRAFT');
        expect(call.update.version).toEqual({ increment: 1 });
    });
});

describe('HR-ATT-POLICY-01 deduction rules', () => {
    it('lists all five keys with missing ones defaulted and DISABLED', async () => {
        const rows = await deductions.listDeductionRules({ tenantId: TENANT });

        expect(rows.map((r) => r.ruleKey)).toEqual(deductions.DEDUCTION_RULE_KEYS);
        expect(rows.every((r) => r.enabled === false)).toBe(true);
    });

    it('keeps MISSING_CHECKIN and MISSING_CHECKOUT as separate keys', async () => {
        // Merging them would let the routine missing check-out consume the
        // threshold meant for the rare, serious missing check-in.
        expect(deductions.DEDUCTION_RULE_KEYS).toContain('MISSING_CHECKIN');
        expect(deductions.DEDUCTION_RULE_KEYS).toContain('MISSING_CHECKOUT');
    });

    it('accepts fractional deduction days', async () => {
        const row = await deductions.upsertDeductionRule({
            tenantId: TENANT, ruleKey: 'LATE', triggerCount: 3, deductionDays: 0.5,
        });

        expect(row.deductionDays).toBe(0.5);
        expect(row.triggerCount).toBe(3);
    });

    it('rejects an unknown rule key', async () => {
        await expect(
            deductions.upsertDeductionRule({ tenantId: TENANT, ruleKey: 'SOMETHING_ELSE' }),
        ).rejects.toThrow('ruleKey must be one of');
    });

    it('rejects a deduction large enough to erase a month of salary', async () => {
        await expect(
            deductions.upsertDeductionRule({ tenantId: TENANT, ruleKey: 'LATE', deductionDays: 400 }),
        ).rejects.toThrow('between 0 and 31');
    });

    it('rejects triggerCount below 1', async () => {
        await expect(
            deductions.upsertDeductionRule({ tenantId: TENANT, ruleKey: 'LATE', triggerCount: 0 }),
        ).rejects.toThrow('>= 1');
    });
});

describe('HR-ATT-POLICY-01 approval chain', () => {
    it('rejects a level that can never route to anyone', async () => {
        // No fixed approver and no manager resolution: every request would skip
        // this level and, if it were the only one, auto-approve.
        await expect(
            approvals.upsertApprovalLevel({ tenantId: TENANT, level: 2, role: 'HR' }),
        ).rejects.toThrow('either an approverId or useEmployeeManager=true');
    });

    it('accepts the manager level without a fixed approver', async () => {
        const row = await approvals.upsertApprovalLevel({
            tenantId: TENANT, level: 1, role: 'MANAGER', useEmployeeManager: true,
        });

        expect(row.useEmployeeManager).toBe(true);
        expect(row.role).toBe('MANAGER');
    });

    it('rejects an approver from another tenant', async () => {
        // findUnique is RLS-scoped, so a foreign id simply reads as missing.
        prismaMock.employee.findUnique.mockResolvedValue(null);

        await expect(
            approvals.upsertApprovalLevel({ tenantId: TENANT, level: 2, role: 'HR', approverId: 999 }),
        ).rejects.toThrow('not found in this tenant');
    });

    it('accepts an HR approver picked from the employee list', async () => {
        prismaMock.employee.findUnique.mockResolvedValue({ id: 42 });

        const row = await approvals.upsertApprovalLevel({
            tenantId: TENANT, level: 2, role: 'HR', approverId: 42,
        });

        expect(row.approverId).toBe(42);
    });

    it('returns picker candidates with a usable display name', async () => {
        prismaMock.employee.findMany.mockResolvedValue([
            { id: 1, employee_code: 'EMP001', employee_name: null, first_name: 'Asad', last_name: 'Ullah', job_title: 'Engineer' },
            { id: 2, employee_code: 'EMP002', employee_name: 'Full Name', first_name: null, last_name: null, job_title: null },
        ]);

        const rows = await approvals.listApproverCandidates({ tenantId: TENANT, search: 'a' });

        expect(rows[0].name).toBe('Asad Ullah');   // employee_name is often null
        expect(rows[1].name).toBe('Full Name');
    });

    it('caps the candidate page size', async () => {
        await approvals.listApproverCandidates({ tenantId: TENANT, limit: 5000 });

        expect(prismaMock.employee.findMany.mock.calls[0][0].take).toBe(200);
    });
});

// HR-ATT-POLICY-01 — attendance config must travel with the payroll config set.
//
// There are TWO config builders in payrollConfigActions.service.js:
// buildConfigObject() for reads/export, and a private tx-scoped twin
// buildConfigObjectTx() that the published SNAPSHOT is actually built from.
// Adding a section to one and not the other is silent: the screen shows the new
// config, every snapshot omits it, and a payroll re-run cannot reconstruct the
// thresholds that produced a payslip. These tests pin both.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';

const POLICY = { id: 3, graceMinutes: 15, halfDayAfterMinutes: 30, status: 'DRAFT' };
const RULES = [{ id: 1, ruleKey: 'LATE', enabled: false, status: 'DRAFT' }];
const LEVELS = [{ id: 1, level: 1, role: 'MANAGER', useEmployeeManager: true, status: 'DRAFT' }];

const emptyList = jest.fn(async () => []);
const prismaMock = {
    employee: { count: jest.fn(async () => 0) },
    salaryComponent: { findMany: emptyList, count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 0 })) },
    gradeLevel: { findMany: emptyList },
    taxRate: { findMany: emptyList },
    payrollCalendar: { findFirst: jest.fn(async () => null), count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 0 })) },
    payrollApprovalMatrix: { findMany: emptyList },
    payrollRuleConfig: { findFirst: jest.fn(async () => null), count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 0 })) },
    payrollConfigSnapshot: { count: jest.fn(async () => 1), create: jest.fn(async ({ data }) => ({ id: 9, ...data })) },
    payrollConfigMeta: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
    attendancePolicyConfig: { findFirst: jest.fn(async () => POLICY), count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 1 })) },
    attendanceDeductionRule: { findMany: jest.fn(async () => RULES), count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 1 })) },
    attendanceApprovalLevel: { findMany: jest.fn(async () => LEVELS), count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 1 })) },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_client, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/tenancy.js', () => ({
    scopedWhere: (tenantId, where) => ({ ...where, tenantId }),
    scopedEmployeeWhere: (tenantId, where) => ({ ...where, tenant_id: tenantId }),
}));
jest.unstable_mockModule('../../src/services/payrollRuleConfig.service.js', () => ({
    getPayrollRules: jest.fn(async () => ({ id: null, status: 'DRAFT' })),
}));
jest.unstable_mockModule('../../src/services/attendancePolicyConfig.service.js', () => ({
    getAttendancePolicy: jest.fn(async () => POLICY),
}));
jest.unstable_mockModule('../../src/services/attendanceDeductionRule.service.js', () => ({
    listDeductionRules: jest.fn(async () => RULES),
}));
jest.unstable_mockModule('../../src/services/attendanceApprovalLevel.service.js', () => ({
    listApprovalLevels: jest.fn(async () => LEVELS),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const actions = await import('../../src/services/payrollConfigActions.service.js');

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.payrollConfigSnapshot.count.mockResolvedValue(1);
    prismaMock.payrollConfigMeta.findUnique.mockResolvedValue(null);
    prismaMock.attendancePolicyConfig.findFirst.mockResolvedValue(POLICY);
    prismaMock.attendanceDeductionRule.findMany.mockResolvedValue(RULES);
    prismaMock.attendanceApprovalLevel.findMany.mockResolvedValue(LEVELS);
    for (const key of ['salaryComponent', 'payrollCalendar', 'payrollRuleConfig',
        'attendancePolicyConfig', 'attendanceDeductionRule', 'attendanceApprovalLevel']) {
        prismaMock[key].count.mockResolvedValue(0);
    }
});

const ATTENDANCE_KEYS = ['attendancePolicy', 'attendanceDeductionRules', 'attendanceApprovalLevels'];

describe('HR-ATT-POLICY-01 attendance config joins the payroll config set', () => {
    it('buildConfigObject exposes the attendance sections', async () => {
        const config = await actions.buildConfigObject({ tenantId: TENANT });

        for (const key of ATTENDANCE_KEYS) expect(config).toHaveProperty(key);
        expect(config.attendanceDeductionRules).toEqual(RULES);
    });

    it('the PUBLISHED SNAPSHOT carries them too (the tx-scoped twin)', async () => {
        await actions.publishConfig({ tenantId: TENANT, publishedById: 1 });

        const snapshot = prismaMock.payrollConfigSnapshot.create.mock.calls[0][0].data.config;
        for (const key of ATTENDANCE_KEYS) expect(snapshot).toHaveProperty(key);
        expect(snapshot.attendanceApprovalLevels).toEqual(LEVELS);
    });

    it('publish flips the three attendance tables DRAFT -> PUBLISHED', async () => {
        await actions.publishConfig({ tenantId: TENANT, publishedById: 1 });

        for (const key of ['attendancePolicyConfig', 'attendanceDeductionRule', 'attendanceApprovalLevel']) {
            expect(prismaMock[key].updateMany).toHaveBeenCalledWith(
                expect.objectContaining({ data: { status: 'PUBLISHED' } }),
            );
        }
    });

    it.each([
        ['attendancePolicyConfig'],
        ['attendanceDeductionRule'],
        ['attendanceApprovalLevel'],
    ])('a DRAFT row in %s makes the set publishable', async (model) => {
        // Without this the screen reports "nothing to publish" while attendance
        // changes sit unpublished, because only the payroll tables were counted.
        prismaMock[model].count.mockResolvedValue(1);

        const status = await actions.getConfigStatus({ tenantId: TENANT });

        expect(status.hasUnpublished).toBe(true);
    });

    it('reports nothing to publish when every table is clean', async () => {
        const status = await actions.getConfigStatus({ tenantId: TENANT });

        expect(status.hasUnpublished).toBe(false);
    });
});

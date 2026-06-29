// HR-04 / T-P2.2 — tenant-scope the HR payroll (C4) surface.
//
// The verified tenant arrives on req.user.tenantId (set by internalServiceGuard
// from the verified service-JWT claim — T-P2.1). Every payroll read/write must
// carry that tenantId predicate so tenant B can NEVER read/mutate tenant A's
// salaries, payslips, bank/tax data. A cross-tenant read must return not-found,
// never another tenant's row.
//
// These specs mock the shared Prisma singleton and assert the where-clause of
// every payroll query is tenant-scoped, and that a cross-tenant single-read
// (the prisma row belongs to another tenant) yields null/not-found.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── prisma singleton mock ──────────────────────────────────────────────────
const mk = () => ({
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
});

const prismaMock = {
    payrollRun: mk(),
    payrollPayslip: mk(),
    payrollEarning: mk(),
    payrollDeduction: mk(),
    payrollEarningType: mk(),
    payrollDeductionType: mk(),
    employmentTerms: mk(),
    payrollAssignment: mk(),
    bankDetail: mk(),
    taxRate: mk(),
    payrollAuditLog: mk(),
    employee: mk(),
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/utils/logs.js', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));

const payroll = await import('../../src/services/payrollService.js');

// REQ-007 — the tenant is now an opaque RBAC Company.uuid STRING (no longer the
// integer companyId). Scoping must thread the uuid string verbatim into every
// where-clause / create.data.tenantId; a DIFFERENT uuid must be isolated.
const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

// Recursively assert a tenantId predicate is present in a where-clause object
// (top level, or nested under AND/OR arrays).
function hasTenantPredicate(where, tenantId) {
    if (!where || typeof where !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(where, 'tenantId') && where.tenantId === tenantId) return true;
    for (const key of ['AND', 'OR']) {
        if (Array.isArray(where[key]) && where[key].some((w) => hasTenantPredicate(w, tenantId))) return true;
    }
    return false;
}

beforeEach(() => {
    for (const model of Object.values(prismaMock)) {
        for (const fn of Object.values(model)) fn.mockReset();
    }
});

describe('HR-04 payroll read scoping — tenantId predicate present', () => {
    it('getPayrollRuns scopes findMany + count by tenantId', async () => {
        prismaMock.payrollRun.findMany.mockResolvedValue([]);
        prismaMock.payrollRun.count.mockResolvedValue(0);

        await payroll.getPayrollRuns({ page: 1, limit: 10, tenantId: TENANT_A });

        expect(hasTenantPredicate(prismaMock.payrollRun.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.payrollRun.count.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('getPayrollRunById scopes by tenantId (findFirst, not unscoped findUnique)', async () => {
        prismaMock.payrollRun.findFirst.mockResolvedValue(null);

        await payroll.getPayrollRunById(10, TENANT_A);

        const call = prismaMock.payrollRun.findFirst.mock.calls[0][0];
        expect(hasTenantPredicate(call.where, TENANT_A)).toBe(true);
        expect(call.where.id).toBe(10);
    });

    it('getPayslips scopes findMany + count by tenantId', async () => {
        prismaMock.payrollPayslip.findMany.mockResolvedValue([]);
        prismaMock.payrollPayslip.count.mockResolvedValue(0);

        await payroll.getPayslips({ page: 1, limit: 10, tenantId: TENANT_A });

        expect(hasTenantPredicate(prismaMock.payrollPayslip.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.payrollPayslip.count.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('getPayslipById scopes by tenantId', async () => {
        prismaMock.payrollPayslip.findFirst.mockResolvedValue(null);

        await payroll.getPayslipById(5, TENANT_A);

        const call = prismaMock.payrollPayslip.findFirst.mock.calls[0][0];
        expect(hasTenantPredicate(call.where, TENANT_A)).toBe(true);
        expect(call.where.id).toBe(5);
    });

    it('getEmployeePayslips scopes findMany + count by tenantId', async () => {
        prismaMock.payrollPayslip.findMany.mockResolvedValue([]);
        prismaMock.payrollPayslip.count.mockResolvedValue(0);

        await payroll.getEmployeePayslips(3, { page: 1, limit: 10, tenantId: TENANT_A });

        expect(hasTenantPredicate(prismaMock.payrollPayslip.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.payrollPayslip.count.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('getEmployeePayrollData scopes terms, assignments, bank details, payslips by tenantId', async () => {
        prismaMock.employmentTerms.findMany.mockResolvedValue([]);
        prismaMock.payrollAssignment.findMany.mockResolvedValue([]);
        prismaMock.bankDetail.findMany.mockResolvedValue([]);
        prismaMock.payrollPayslip.findMany.mockResolvedValue([]);

        await payroll.getEmployeePayrollData(3, TENANT_A);

        expect(hasTenantPredicate(prismaMock.employmentTerms.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.payrollAssignment.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.bankDetail.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.payrollPayslip.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('getEarningTypes / getDeductionTypes / getTaxRates / getAuditLogs scope by tenantId', async () => {
        prismaMock.payrollEarningType.findMany.mockResolvedValue([]);
        prismaMock.payrollDeductionType.findMany.mockResolvedValue([]);
        prismaMock.taxRate.findMany.mockResolvedValue([]);
        prismaMock.payrollAuditLog.findMany.mockResolvedValue([]);
        prismaMock.payrollAuditLog.count.mockResolvedValue(0);

        await payroll.getEarningTypes(TENANT_A);
        await payroll.getDeductionTypes(TENANT_A);
        await payroll.getTaxRates(undefined, TENANT_A);
        await payroll.getAuditLogs({ page: 1, limit: 10, tenantId: TENANT_A });

        expect(hasTenantPredicate(prismaMock.payrollEarningType.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.payrollDeductionType.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.taxRate.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.payrollAuditLog.findMany.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(hasTenantPredicate(prismaMock.payrollAuditLog.count.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });
});

describe('HR-04 payroll write scoping — tenantId stamped on create', () => {
    it('createPayrollRun stamps tenantId and scopes the overlap check', async () => {
        prismaMock.payrollRun.findFirst.mockResolvedValue(null);
        prismaMock.payrollRun.create.mockResolvedValue({ id: 1 });

        await payroll.createPayrollRun(
            { periodStart: new Date('2024-01-01'), periodEnd: new Date('2024-01-31'), countryCode: 'US', currencyCode: 'USD' },
            99,
            TENANT_A
        );

        expect(hasTenantPredicate(prismaMock.payrollRun.findFirst.mock.calls[0][0].where, TENANT_A)).toBe(true);
        expect(prismaMock.payrollRun.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });

    it('createEarningType / createDeductionType / createTaxRate stamp tenantId', async () => {
        prismaMock.payrollEarningType.create.mockResolvedValue({ id: 1, name: 'x' });
        prismaMock.payrollDeductionType.create.mockResolvedValue({ id: 1, name: 'x' });
        prismaMock.taxRate.create.mockResolvedValue({ id: 1, countryCode: 'US', bracketMin: 0, bracketMax: 1 });

        await payroll.createEarningType({ code: 'A', name: 'x' }, 99, TENANT_A);
        await payroll.createDeductionType({ code: 'B', name: 'y' }, 99, TENANT_A);
        await payroll.createTaxRate({ countryCode: 'US', bracketMin: 0, bracketMax: 1, rate: 0.1, effectiveFrom: new Date() }, 99, TENANT_A);

        expect(prismaMock.payrollEarningType.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
        expect(prismaMock.payrollDeductionType.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
        expect(prismaMock.taxRate.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });

    it('createEmploymentTerms / createPayrollAssignment stamp tenantId', async () => {
        prismaMock.employmentTerms.create.mockResolvedValue({ id: 1, employeeId: 3 });
        prismaMock.payrollAssignment.create.mockResolvedValue({ id: 1, employeeId: 3 });

        await payroll.createEmploymentTerms({ employeeId: 3, baseSalary: 1 }, 99, TENANT_A);
        await payroll.createPayrollAssignment({ employeeId: 3 }, 99, TENANT_A);

        expect(prismaMock.employmentTerms.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
        expect(prismaMock.payrollAssignment.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    });
});

describe('HR-04 cross-tenant isolation — tenant B cannot read tenant A', () => {
    it('getPayrollRunById returns not-found when the row belongs to another tenant', async () => {
        // tenant A owns run #10; tenant B queries scoped by tenantId=B → no match
        prismaMock.payrollRun.findFirst.mockImplementation(async ({ where }) =>
            where.id === 10 && where.tenantId === TENANT_A ? { id: 10, tenantId: TENANT_A } : null
        );

        const asOwner = await payroll.getPayrollRunById(10, TENANT_A);
        const asOther = await payroll.getPayrollRunById(10, TENANT_B);

        expect(asOwner).toEqual({ id: 10, tenantId: TENANT_A });
        expect(asOther).toBeNull(); // tenant B sees not-found, NOT tenant A's run
    });

    it('getPayslipById returns not-found when the payslip belongs to another tenant', async () => {
        prismaMock.payrollPayslip.findFirst.mockImplementation(async ({ where }) =>
            where.id === 5 && where.tenantId === TENANT_A ? { id: 5, tenantId: TENANT_A, employeeId: 3 } : null
        );

        const asOwner = await payroll.getPayslipById(5, TENANT_A);
        const asOther = await payroll.getPayslipById(5, TENANT_B);

        expect(asOwner).toMatchObject({ id: 5, tenantId: TENANT_A });
        expect(asOther).toBeNull(); // tenant B cannot read tenant A's payslip
    });

    it('distributePayslip throws not-found for a cross-tenant payslip (no mutation)', async () => {
        prismaMock.payrollPayslip.findFirst.mockImplementation(async ({ where }) =>
            where.id === 5 && where.tenantId === TENANT_A ? { id: 5, tenantId: TENANT_A, status: 'FINALIZED', employeeId: 3 } : null
        );

        await expect(payroll.distributePayslip(5, 99, TENANT_B)).rejects.toThrow(/not found/i);
        expect(prismaMock.payrollPayslip.update).not.toHaveBeenCalled(); // never mutated tenant A's row
    });
});

describe('REQ-007 — tenant is an opaque uuid STRING (no int coercion)', () => {
    it('scopes a uuid-tenant query by the uuid string VERBATIM (not Number()/parseInt())', async () => {
        prismaMock.payrollRun.findFirst.mockResolvedValue(null);

        await payroll.getPayrollRunById(10, TENANT_A);

        const where = prismaMock.payrollRun.findFirst.mock.calls[0][0].where;
        // the literal uuid string must survive into the predicate, untouched
        expect(where.tenantId).toBe(TENANT_A);
        expect(typeof where.tenantId).toBe('string');
        expect(Number.isNaN(Number(where.tenantId))).toBe(true); // proves it was never numeric-coerced
    });

    it('a uuid-scoped payroll query returns only that tenant; a DIFFERENT uuid is isolated', async () => {
        // run #10 belongs to tenant A (its uuid). A query scoped by tenant B's
        // uuid string resolves to not-found — never tenant A's row.
        prismaMock.payrollRun.findFirst.mockImplementation(async ({ where }) =>
            where.id === 10 && where.tenantId === TENANT_A ? { id: 10, tenantId: TENANT_A } : null
        );

        const own = await payroll.getPayrollRunById(10, TENANT_A);
        const other = await payroll.getPayrollRunById(10, TENANT_B);

        expect(own).toEqual({ id: 10, tenantId: TENANT_A });
        expect(other).toBeNull();
    });

    it('stamps the uuid string verbatim on create (createPayrollRun)', async () => {
        prismaMock.payrollRun.findFirst.mockResolvedValue(null);
        prismaMock.payrollRun.create.mockResolvedValue({ id: 1 });

        await payroll.createPayrollRun(
            { periodStart: new Date('2024-01-01'), periodEnd: new Date('2024-01-31'), countryCode: 'US', currencyCode: 'USD' },
            99,
            TENANT_A
        );

        expect(prismaMock.payrollRun.create.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
        // the period-overlap (uniqueness) guard is itself tenant-scoped, so two
        // DIFFERENT tenants may own the same period — REQ-006 follow-up.
        expect(hasTenantPredicate(prismaMock.payrollRun.findFirst.mock.calls[0][0].where, TENANT_A)).toBe(true);
    });

    it('null tenant is fail-closed (matches only null-tenant rows, never coerced)', async () => {
        prismaMock.payrollRun.findFirst.mockResolvedValue(null);

        await payroll.getPayrollRunById(10, null);

        const where = prismaMock.payrollRun.findFirst.mock.calls[0][0].where;
        expect(where.tenantId).toBeNull();
    });
});

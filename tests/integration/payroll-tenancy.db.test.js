// HR-04 / T-P2.2 — seeded two-tenant DB probe.
//
// This is the strongest cross-tenant isolation proof: it seeds REAL rows for
// two tenants in the live erp-hr database through the shared Prisma singleton,
// then exercises the REAL payrollService against them and asserts tenant B can
// NEVER read tenant A's payslip / payroll run / employee data — every scoped
// read of a foreign-tenant id returns not-found (null), never the other
// tenant's salary/payslip rows. All seeded rows are torn down afterwards.
//
// Runs only when a Postgres DATABASE_URL is reachable; otherwise it skips so
// the unit-level mock proof (payroll-tenancy.test.js) remains the gate.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import prisma from '../../src/lib/prisma.js';
import * as payroll from '../../src/services/payrollService.js';

// REQ-007 — tenant ids are RBAC Company.uuid STRINGS (no longer integers). The
// columns are now String @db.Uuid, so the seeds MUST be valid uuids or the
// inserts fail. Two distinct uuids prove cross-tenant isolation on the uuid type.
const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';

let dbAvailable = false;
const created = { employees: [], runs: [], payslips: [] };

beforeAll(async () => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        dbAvailable = true;
    } catch {
        dbAvailable = false;
        return;
    }

    // Two employees, one per tenant.
    const empA = await prisma.employee.create({ data: { tenant_id: TENANT_A, first_name: 'A', last_name: 'Owner', status: 'active' } });
    const empB = await prisma.employee.create({ data: { tenant_id: TENANT_B, first_name: 'B', last_name: 'Owner', status: 'active' } });
    created.employees.push(empA.id, empB.id);

    // One payroll run per tenant (distinct periods to respect the global
    // [periodStart, periodEnd] unique constraint).
    const runA = await prisma.payrollRun.create({
        data: { tenantId: TENANT_A, periodStart: new Date('2099-01-01'), periodEnd: new Date('2099-01-31'), countryCode: 'US', currencyCode: 'USD', status: 'COMPLETED' },
    });
    const runB = await prisma.payrollRun.create({
        data: { tenantId: TENANT_B, periodStart: new Date('2099-02-01'), periodEnd: new Date('2099-02-28'), countryCode: 'US', currencyCode: 'USD', status: 'COMPLETED' },
    });
    created.runs.push(runA.id, runB.id);

    // A payslip per tenant carrying the tenant's salary figures.
    const slipA = await prisma.payrollPayslip.create({
        data: { tenantId: TENANT_A, payrollRunId: runA.id, employeeId: empA.id, grossAmount: 5000, totalDeductions: 1000, netAmount: 4000, status: 'FINALIZED' },
    });
    const slipB = await prisma.payrollPayslip.create({
        data: { tenantId: TENANT_B, payrollRunId: runB.id, employeeId: empB.id, grossAmount: 7777, totalDeductions: 777, netAmount: 7000, status: 'FINALIZED' },
    });
    created.payslips.push(slipA.id, slipB.id);

    // Stash ids for the specs.
    created.runA = runA.id;
    created.runB = runB.id;
    created.slipA = slipA.id;
    created.slipB = slipB.id;
    created.empA = empA.id;
    created.empB = empB.id;
});

afterAll(async () => {
    if (!dbAvailable) return;
    if (created.payslips.length) await prisma.payrollPayslip.deleteMany({ where: { id: { in: created.payslips } } });
    if (created.runs.length) await prisma.payrollRun.deleteMany({ where: { id: { in: created.runs } } });
    if (created.employees.length) await prisma.employee.deleteMany({ where: { id: { in: created.employees } } });
    await prisma.$disconnect();
});

const guard = () => { if (!dbAvailable) { console.warn('[payroll-tenancy.db] DB unreachable — skipping seeded probe'); } };

describe('HR-04 seeded two-tenant DB probe — tenant B cannot read tenant A', () => {
    it('tenant A reads its own payslip; tenant B gets not-found for the SAME id', async () => {
        guard();
        if (!dbAvailable) return;

        const own = await payroll.getPayslipById(created.slipA, TENANT_A);
        expect(own).not.toBeNull();
        expect(own.grossAmount).toBe(5000);

        // The crux: tenant B scopes by its own tenantId → tenant A's payslip id
        // resolves to nothing. No 7777-vs-5000 leak; not-found, not the row.
        const crossRead = await payroll.getPayslipById(created.slipA, TENANT_B);
        expect(crossRead).toBeNull();
    });

    it('tenant A reads its own payroll run; tenant B gets not-found for the SAME id', async () => {
        guard();
        if (!dbAvailable) return;

        const own = await payroll.getPayrollRunById(created.runA, TENANT_A);
        expect(own).not.toBeNull();

        const crossRead = await payroll.getPayrollRunById(created.runA, TENANT_B);
        expect(crossRead).toBeNull();
    });

    it('getPayslips list for tenant B never contains tenant A payslips (and vice versa)', async () => {
        guard();
        if (!dbAvailable) return;

        const listA = await payroll.getPayslips({ page: 1, limit: 100, tenantId: TENANT_A });
        const listB = await payroll.getPayslips({ page: 1, limit: 100, tenantId: TENANT_B });

        const idsA = listA.payslips.map((p) => p.id);
        const idsB = listB.payslips.map((p) => p.id);

        expect(idsA).toContain(created.slipA);
        expect(idsA).not.toContain(created.slipB);
        expect(idsB).toContain(created.slipB);
        expect(idsB).not.toContain(created.slipA);
    });

    it('getEmployeePayrollData for tenant B cannot see tenant A employee payslips', async () => {
        guard();
        if (!dbAvailable) return;

        // Ask for tenant A's employee but scoped as tenant B → empty payslips.
        const asB = await payroll.getEmployeePayrollData(created.empA, TENANT_B);
        expect(asB.recentPayslips).toHaveLength(0);

        // Same employee, correct tenant → the seeded payslip is visible.
        const asA = await payroll.getEmployeePayrollData(created.empA, TENANT_A);
        expect(asA.recentPayslips.length).toBeGreaterThanOrEqual(1);
    });

    it('distributePayslip on a cross-tenant payslip is not-found and does NOT mutate', async () => {
        guard();
        if (!dbAvailable) return;

        await expect(payroll.distributePayslip(created.slipA, 0, TENANT_B)).rejects.toThrow(/not found/i);

        // tenant A's payslip is untouched (still FINALIZED, not DISTRIBUTED).
        const untouched = await prisma.payrollPayslip.findUnique({ where: { id: created.slipA } });
        expect(untouched.status).toBe('FINALIZED');
        expect(untouched.distributedAt).toBeNull();
    });
});

// HR-02 / HR-07 (Roadmap T-P4.1) — approval gate + idempotency against the REAL
// engine and the live HR database (shared Prisma singleton).
//
// Proves the four behaviours the golden-file unit test cannot (they need real
// rows + status transitions):
//   * FINALIZE is BLOCKED without an approval.
//   * FINALIZE is BLOCKED on self-approval (processor == approver).
//   * FINALIZE SUCCEEDS with a DISTINCT approver.
//   * Re-PROCESSING the same run is idempotent — no duplicate payslips, no
//     doubled totals.
// Also confirms the run records the rule version it was computed against
// (reproducibility) and that tax came from the seeded TaxRate table, not the
// removed 15%/5% constants.
//
// Runs only when a Postgres DATABASE_URL is reachable; otherwise it skips,
// mirroring payroll-tenancy.db.test.js / HR-01.c4-encrypted-at-rest.test.js.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import prisma from '../../src/lib/prisma.js';
import * as payroll from '../../src/services/payrollService.js';

// REQ-007 — tenant is an RBAC Company.uuid STRING (was an int). Isolated test tenant.
const TENANT = '93010000-0000-4000-8000-000000000001';
const PROCESSOR = 930101;
const APPROVER = 930102;

let dbAvailable = false;
const created = { employees: [], runs: [], taxRates: [], terms: [] };

beforeAll(async () => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        dbAvailable = true;
    } catch {
        dbAvailable = false;
        return;
    }

    // Defensive: purge any leftover 2097 runs for this test tenant from an
    // interrupted prior run so the tenant-scoped [tenantId, periodStart,
    // periodEnd] unique constraint (REQ-006/REQ-007) never collides across re-runs.
    const stale = await prisma.payrollRun.findMany({
        where: { tenantId: TENANT, periodStart: { gte: new Date('2097-01-01'), lt: new Date('2098-01-01') } },
        select: { id: true },
    });
    for (const r of stale) {
        await prisma.payrollAuditLog.deleteMany({ where: { payrollRunId: r.id } });
        const slips = await prisma.payrollPayslip.findMany({ where: { payrollRunId: r.id }, select: { id: true } });
        for (const s of slips) {
            await prisma.payrollEarning.deleteMany({ where: { payslipId: s.id } });
            await prisma.payrollDeduction.deleteMany({ where: { payslipId: s.id } });
        }
        await prisma.payrollPayslip.deleteMany({ where: { payrollRunId: r.id } });
    }
    if (stale.length) await prisma.payrollRun.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });

    // The payroll engine auto-provisions a tenant-scoped BASE_SALARY earning type
    // and the tax deduction types on first process. PayrollEarningType.code /
    // PayrollDeductionType.code are GLOBALLY unique, so any pre-existing rows with
    // these codes (e.g. dev-seed rows whose int tenant was un-mappable and nulled
    // by the REQ-007 backfill) would collide with the per-tenant create. Purge any
    // such leftovers up-front so this spec owns its catalog deterministically.
    await prisma.payrollEarningType.deleteMany({ where: { code: { in: ['BASE_SALARY'] } } });
    await prisma.payrollDeductionType.deleteMany({ where: { code: { in: ['FED_TAX', 'STATE_TAX', 'INCOME_TAX', 'TAX'] } } });

    // Two employees: one is paid, the other plays processor/approver actors.
    const emp = await prisma.employee.create({
        data: { tenant_id: TENANT, first_name: 'Pay', last_name: 'Ee', status: 'active' },
    });
    created.employees.push(emp.id);
    created.emp = emp.id;

    // Employment terms — monthly base. Written through the C4 extension (string
    // at rest, number on read); the engine reads it back as a Number.
    const term = await prisma.employmentTerms.create({
        data: {
            tenantId: TENANT,
            employeeId: emp.id,
            baseSalary: 5000,
            currency: 'USD',
            payFrequency: 'MONTHLY',
            effectiveFrom: new Date('2097-01-01'),
            effectiveTo: null,
        },
    });
    created.terms.push(term.id);

    // Seed a versioned progressive tax table for US effective in the run window.
    const t1 = await prisma.taxRate.create({
        data: { tenantId: TENANT, countryCode: 'US', bracketMin: 0, bracketMax: 3000, rate: 0.1, effectiveFrom: new Date('2097-01-01'), effectiveTo: null },
    });
    const t2 = await prisma.taxRate.create({
        data: { tenantId: TENANT, countryCode: 'US', bracketMin: 3000, bracketMax: null, rate: 0.2, effectiveFrom: new Date('2097-01-01'), effectiveTo: null },
    });
    created.taxRates.push(t1.id, t2.id);
});

afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of created.runs) {
        await prisma.payrollAuditLog.deleteMany({ where: { payrollRunId: id } });
        await prisma.payrollPayslip.deleteMany({ where: { payrollRunId: id } });
    }
    if (created.runs.length) await prisma.payrollRun.deleteMany({ where: { id: { in: created.runs } } });
    if (created.taxRates.length) await prisma.taxRate.deleteMany({ where: { id: { in: created.taxRates } } });
    if (created.terms.length) await prisma.employmentTerms.deleteMany({ where: { id: { in: created.terms } } });
    if (created.employees.length) await prisma.employee.deleteMany({ where: { id: { in: created.employees } } });
    // Tear down the engine-provisioned tenant-scoped catalog rows for this tenant.
    await prisma.payrollEarningType.deleteMany({ where: { tenantId: TENANT } });
    await prisma.payrollDeductionType.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$disconnect();
});

const guard = () => !dbAvailable;

// The PayrollRun period uniqueness is now tenant-scoped:
// @@unique([tenantId, periodStart, periodEnd]) (REQ-006/REQ-007). Within THIS
// single tenant a period must still be unique, so each test mints a DISTINCT
// month from a monotonically increasing counter to avoid intra-tenant collisions.
let periodSeq = 0;
const freshRun = async () => {
    const month = periodSeq;
    periodSeq += 1;
    const start = new Date(Date.UTC(2097, month, 1));
    const end = new Date(Date.UTC(2097, month + 1, 0)); // last day of the month
    const run = await payroll.createPayrollRun(
        {
            periodStart: start,
            periodEnd: end,
            countryCode: 'US',
            currencyCode: 'USD',
        },
        PROCESSOR,
        TENANT,
    );
    created.runs.push(run.id);
    return run;
};

describe('HR-02 approval gate + idempotency (real engine, live DB)', () => {
    it('processing records the processor, rule version, and table-driven tax (not 15/5)', async () => {
        if (guard()) return;
        const run = await freshRun();

        const processed = await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);
        expect(processed.status).toBe('COMPLETED');
        expect(processed.processedBy).toBe(PROCESSOR);
        expect(processed.ruleVersion).toBeTruthy();
        expect(processed.ratesEffectiveAt).toBeTruthy();

        const slip = processed.payslips[0];
        // gross 5000 → progressive tax = 10% of 3000 + 20% of 2000 = 300 + 400 = 700
        // legacy flat (15+5)%*5000 = 1000 → assert it is the table figure, not 1000.
        const tax = slip.deductions
            .filter((d) => /tax/i.test(d.description))
            .reduce((acc, d) => acc + d.amount, 0);
        expect(tax).toBe(700);
        expect(tax).not.toBe(1000);
        expect(slip.ruleVersion).toBe(processed.ruleVersion);
    });

    it('re-processing the SAME run is idempotent — no duplicate payslips, no doubled totals', async () => {
        if (guard()) return;
        const run = await freshRun();

        const first = await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);
        const firstCount = first.payslips.length;
        const firstNet = first.totalNet;

        const again = await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);
        expect(again.payslips.length).toBe(firstCount);
        expect(again.totalNet).toBe(firstNet);

        const slips = await prisma.payrollPayslip.count({ where: { payrollRunId: run.id } });
        expect(slips).toBe(firstCount);
    });

    it('FINALIZE is BLOCKED without an approval', async () => {
        if (guard()) return;
        const run = await freshRun();
        await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);
        await expect(payroll.finalizePayrollRun(run.id, PROCESSOR, TENANT)).rejects.toThrow(/approv/i);
    });

    it('FINALIZE is BLOCKED on self-approval (processor == approver)', async () => {
        if (guard()) return;
        const run = await freshRun();
        await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);
        await expect(payroll.approvePayrollRun(run.id, PROCESSOR, TENANT)).rejects.toThrow(/self|distinct|same/i);
    });

    it('FINALIZE SUCCEEDS with a DISTINCT approver', async () => {
        if (guard()) return;
        const run = await freshRun();
        await payroll.processPayrollRun(run.id, PROCESSOR, TENANT);

        const approved = await payroll.approvePayrollRun(run.id, APPROVER, TENANT);
        expect(approved.approvedBy).toBe(APPROVER);
        expect(approved.status).toBe('APPROVED');

        const finalized = await payroll.finalizePayrollRun(run.id, APPROVER, TENANT);
        expect(finalized.status).toBe('FINALIZED');
        const slipStatuses = finalized.payslips.map((p) => p.status);
        expect(slipStatuses.every((s) => s === 'FINALIZED')).toBe(true);
    });
});

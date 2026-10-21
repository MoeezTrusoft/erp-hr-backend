// Exercise the current Approval Centre workflow against the migrated fixture.
// The retired approvePayrollRun entrypoint cannot authorize a payment.
import { beforeAll, afterAll, describe, it, expect } from '@jest/globals';
import { setupPayroll, prisma, company, people, db, as, submit, act } from '../payroll/fixtures.mjs';
import * as payroll from '../../src/services/payrollService.js';
import { publishConfig } from '../../src/services/payrollConfigActions.service.js';
import { decimalToMinor } from '../../src/lib/money.js';

let run, processed, review;
const calculate = () => as('EMPLOYEE', () => payroll.processPayrollRun(run.id, people.EMPLOYEE.id, company));
beforeAll(async () => {
    ({ run } = await setupPayroll());
    await db(async tx => {
        await tx.employmentTerms.updateMany({ where: { tenantId: company }, data: { baseSalary: '5000' } });
        await tx.salaryComponent.updateMany({ where: { tenantId: company }, data: { active: false } });
        await tx.taxRate.deleteMany({ where: { tenantId: company } });
        await tx.taxRate.createMany({ data: [
            { tenantId: company, countryCode: 'PK', bracketMin: 0, bracketMax: 3000, rate: 0.1, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01') },
            { tenantId: company, countryCode: 'PK', bracketMin: 3000, bracketMax: null, rate: 0.2, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01') },
        ] });
    });
    await as('EMPLOYEE', () => publishConfig({ tenantId: company, publishedById: String(people.EMPLOYEE.id) }));
}, 60000);
afterAll(() => prisma.$disconnect());

describe('HR-02 payroll calculation, replay and independent approval lifecycle', () => {
    it('records processor, rule version and progressive table-driven tax', async () => {
        processed = await calculate();
        expect(processed.status).toBe('COMPLETED');
        expect(processed.processedBy).toBe(people.EMPLOYEE.id);
        expect(processed.ruleVersion).toBeTruthy();
        expect(processed.ratesEffectiveAt).toBeTruthy();
        const slip = processed.payslips[0];
        const tax = slip.deductions.filter(d => /tax/i.test(d.description))
            .reduce((sum, d) => sum + decimalToMinor(d.amount, 'PKR'), 0n);
        expect(tax).toBe(70000n);
        expect(tax).not.toBe(100000n);
        expect(slip.ruleVersion).toBe(processed.ruleVersion);
    });

    it('recalculation cannot duplicate payslips, loan reservations or totals', async () => {
        const before = await db(tx => tx.loanRepayment.count({ where: { tenantId: company, payrollRunId: run.id } }));
        const again = await calculate();
        expect(again.payslips.length).toBe(processed.payslips.length);
        expect(String(again.totalNet)).toBe(String(processed.totalNet));
        expect(await db(tx => tx.payrollPayslip.count({ where: { tenantId: company, payrollRunId: run.id } })))
            .toBe(processed.payslips.length);
        expect(await db(tx => tx.loanRepayment.count({ where: { tenantId: company, payrollRunId: run.id } }))).toBe(before);
    });

    it('finalization remains blocked until the independent approval workflow finishes', async () => {
        await expect(as('HR', () => payroll.finalizePayrollRun(run.id, people.HR.id, company))).rejects.toThrow(/approv/i);
    });

    it('the initiator cannot approve itself or bypass Approval Centre through the retired API', async () => {
        await expect(as('EMPLOYEE', () => payroll.approvePayrollRun(run.id, people.EMPLOYEE.id, company))).rejects.toThrow();
        review = await submit({ kind: 'PAYROLL', ref: String(run.id) });
        await expect(act('EMPLOYEE', review, 'APPROVE')).rejects.toThrow();
        const unchanged = await db(tx => tx.payrollRun.findFirst({ where: { tenantId: company, id: run.id } }));
        expect(unchanged.status).toBe('COMPLETED');
        expect(unchanged.approvedBy).toBeNull();
    });

    it('manager recommendation, HR verification and distinct management approval permit finalization', async () => {
        review = await act('MANAGER', review, 'RECOMMEND_APPROVAL');
        review = await act('HR', review, 'VERIFY');
        review = await act('MANAGEMENT', review, 'APPROVE');
        expect(review.stage).toBe('APPROVED');
        const approved = await as('HR', () => payroll.getPayrollRunById(run.id, company));
        expect(approved.approvedBy).not.toBe(people.EMPLOYEE.id);
        expect(approved.approvedBy).not.toBeNull();
        expect(approved.status).toBe('APPROVED');
        const finalized = await as('HR', () => payroll.finalizePayrollRun(run.id, people.HR.id, company));
        expect(finalized.status).toBe('FINALIZED');
        expect(finalized.payslips.every(s => s.status === 'FINALIZED')).toBe(true);
    });
});

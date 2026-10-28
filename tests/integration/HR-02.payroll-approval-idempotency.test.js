// Exercise the current Timesheet → calculation → Approval Centre → finalization
// workflow against the same fully configured fixture used by the payroll suite.
// The old fixture bypassed current setup and called the retired direct approval API.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { decimalToMinor } from '../../src/lib/money.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;
let fixture, payroll, run;

databaseSuite('HR-02 approval gate + idempotency (real engine, live DB)', () => {
  beforeAll(async () => {
    process.env.ASSESSMENT_TEST_DATABASE_URL = databaseUrl;
    fixture = await import('../payroll/fixtures.mjs');
    payroll = await import('../../src/services/payrollService.js');
    ({ run } = await fixture.setupPayroll());
  }, 60000);
  afterAll(async () => { if (fixture) await fixture.prisma.$disconnect(); });
  const processRun = () => fixture.as('EMPLOYEE', () =>
    payroll.processPayrollRun(run.id, fixture.people.EMPLOYEE.id, fixture.company));

  it('records the verified processor, rule version and published progressive tax', async () => {
    const processed = await processRun();
    expect(processed.status).toBe('COMPLETED');
    expect(processed.processedBy).toBe(fixture.people.EMPLOYEE.id);
    expect(processed.ruleVersion).toBeTruthy();
    expect(processed.ratesEffectiveAt).toBeTruthy();
    const slip = processed.payslips[0];
    // Published 10% table on 110,000 PKR gross, not the obsolete flat 15%+5%.
    const tax = slip.deductions.filter(d => /tax/i.test(d.description))
      .reduce((sum, d) => sum + decimalToMinor(d.amount, 'PKR'), 0n);
    expect(tax).toBe(1100000n);
    expect(tax).not.toBe(2200000n);
    expect(slip.ruleVersion).toBe(processed.ruleVersion);
  }, 60000);

  it('reprocessing preserves totals and creates no duplicate payslips or loan reservations', async () => {
    const first = await processRun();
    const again = await processRun();
    expect(again.payslips.length).toBe(first.payslips.length);
    expect(String(again.totalNet)).toBe(String(first.totalNet));
    const counts = await fixture.db(async tx => ({
      slips: await tx.payrollPayslip.count({ where: { payrollRunId: run.id } }),
      loans: await tx.loanRepayment.count({ where: { payrollRunId: run.id } }),
    }));
    expect(counts).toEqual({ slips: first.payslips.length, loans: 1 });
  }, 60000);

  it('blocks finalization before approval', async () => {
    await expect(fixture.as('HR', () => payroll.finalizePayrollRun(
      run.id, fixture.people.HR.id, fixture.company))).rejects.toThrow(/approv/i);
  });

  it('blocks self-approval through the Approval Centre', async () => {
    const review = await fixture.submit({ kind: 'PAYROLL', ref: String(run.id) });
    await expect(fixture.act('EMPLOYEE', review, 'RECOMMEND_APPROVAL')).rejects.toThrow();
    expect((await fixture.db(tx => tx.payrollRun.findUnique({ where: { id: run.id } }))).approvedBy).toBeNull();
    run.review = review;
  });

  it('finalizes only after independent manager, HR and management approval', async () => {
    let review = await fixture.act('MANAGER', run.review, 'RECOMMEND_APPROVAL');
    review = await fixture.act('HR', review, 'VERIFY');
    await fixture.act('MANAGEMENT', review, 'APPROVE');
    const approved = await fixture.db(tx => tx.payrollRun.findUnique({ where: { id: run.id } }));
    expect(approved.approvedBy).toBe(fixture.people.MANAGEMENT.id);
    expect(approved.status).toBe('APPROVED');
    const finalized = await fixture.as('MANAGEMENT', () => payroll.finalizePayrollRun(
      run.id, fixture.people.MANAGEMENT.id, fixture.company));
    expect(finalized.status).toBe('FINALIZED');
    expect(finalized.payslips.every(s => s.status === 'FINALIZED')).toBe(true);
  }, 60000);
});

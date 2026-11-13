// A1 (plan 25) / T-2.4 (plan 20) — [A-02] garnishment-cap default divergence.
//
// The engine's fallback cap is `40n` (payrollService.js:553) while the config
// service's published default is 33 (payrollRuleConfig.service.js). With an
// empty rule-config row the engine silently caps garnishments at 40% — a value
// HR never signed. One default, one source: 33.
//
// RED here = an empty ruleConfig ({}) caps the loan line at 40% of gross.
// After the fix, the same inputs must cap at 33%.
import { describe, it, expect } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const grossOf = (payslip) =>
  payslip.earnings.reduce((s, e) => s + BigInt(Math.round(Number(e.amount) * 100)), 0n);

describe('[A-02] engine garnishment cap with no config (empty ruleConfig)', () => {
  it('caps loan-recovery deductions at 33% of gross (not 40)', () => {
    // gross 100,000 minor; loan installment 90,000 minor → uncapped would take 90%.
    const payslip = buildPayslipFromInputs({
      employee: { id: 1, hire_date: '2020-01-01' },
      employmentTerm: { baseSalary: '1000.00', currency: 'PKR' },
      payrollRun: {
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        periodEnd: new Date('2026-09-30T23:59:59.999Z'),
        currencyCode: 'PKR',
      },
      taxRateRows: [],
      bridges: {
        loanLines: [
          { loanId: 1, amountMinor: 90000n, name: 'Bike Loan' },
        ],
      },
      ruleConfig: {}, // ← no published row: the engine fallback is what we pin
    });

    const loanLine = payslip.deductions.find((d) => d.code === 'LOAN_REPAYMENT');
    expect(loanLine).toBeTruthy();
    // 33% of 100,000 minor = 33,000 minor. A 40% default yields 40,000.
    expect(BigInt(Math.round(Number(loanLine.amount) * 100))).toBe(33000n);
  });
});

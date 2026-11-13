// T-1.2 / N-02 — loan repayment idempotency (plan 20 Phase 1, audit report 19).
//
// Production proof (report 19, CHECK21/22): loans 6 and 8 carry repayment rows
// EXCEEDING their outstanding principal — 3 orphan NULL-run rows per loan plus
// one run-linked row — because processPayrollRun's re-process branch re-created
// the LoanRepayment and re-decremented outstandingMinor whenever a payslip was
// rebuilt. Payslip idempotency (HR-02) replaced the payslip lines but nobody
// told the loan ledger.
//
// Contract under test (pure repayment-planning helper — the DB write sites call
// it before creating/decrementing):
//   planLoanRepayment({ existing, installmentMinor, grossLimitMinor, usedMinor })
//     → { skip: true }                      when a repayment for [loan, run] exists
//     → { skip: false, amountMinor }        capped at the remaining allowance
//
// The integration path (two process calls) is covered live by
// tests/integration/HR-02.payroll-approval-idempotency.test.js conventions;
// this unit test pins the decision logic that guards BOTH write branches.
import { describe, it, expect } from '@jest/globals';
import { planLoanRepayment } from '../../src/services/payrollService.js';

describe('T-1.2 loan repayment idempotency — planLoanRepayment', () => {
    it('SKIP: an existing repayment for the same [loan, run] is never duplicated', () => {
        const plan = planLoanRepayment({
            existing: { id: 33, amountMinor: 500000 },
            installmentMinor: 500000,
            grossLimitMinor: 1000000n,
            usedMinor: 0n,
        });
        expect(plan.skip).toBe(true);
        expect(plan.amountMinor).toBeUndefined();
    });

    it('CREATE: no existing repayment plans the installment, uncapped', () => {
        const plan = planLoanRepayment({
            existing: null,
            installmentMinor: 500000,
            grossLimitMinor: 1000000n,
            usedMinor: 0n,
        });
        expect(plan.skip).toBe(false);
        expect(plan.amountMinor).toBe(500000n);
    });

    it('CAP: the installment is trimmed to the remaining garnishment allowance', () => {
        const plan = planLoanRepayment({
            existing: null,
            installmentMinor: 800000,
            grossLimitMinor: 1000000n,
            usedMinor: 600000n, // 400k left under the cap
        });
        expect(plan.skip).toBe(false);
        expect(plan.amountMinor).toBe(400000n);
    });

    it('EXHAUSTED: nothing remains under the cap → a zero amount is never planned', () => {
        const plan = planLoanRepayment({
            existing: null,
            installmentMinor: 800000,
            grossLimitMinor: 1000000n,
            usedMinor: 1000000n,
        });
        expect(plan.skip).toBe(true);
    });

    it('RE-PROCESS SEMANTICS: a rebuilt payslip does not double-decrement — the existing row wins over any recomputed amount', () => {
        // Even if the recomputed installment differs (rules changed between
        // runs of the same period), the recorded repayment for THIS run is the
        // source of truth and is not touched again.
        const plan = planLoanRepayment({
            existing: { id: 34, amountMinor: 2500000 },
            installmentMinor: 999999999,
            grossLimitMinor: 10n,
            usedMinor: 0n,
        });
        expect(plan.skip).toBe(true);
    });
});

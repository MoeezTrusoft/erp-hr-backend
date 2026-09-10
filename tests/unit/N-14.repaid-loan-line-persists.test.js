// N-14 — a fully repaid loan must keep its deduction line on re-process.
//
// The loan bridge selects loans with outstandingMinor > 0 only
// (payrollService.js:1135). Hakim Ali's 10K salary advance (loan 7) was
// recovered by August run 9 — outstanding hit 0. Re-processing run 9 now
// EXCLUDES the loan, so the rebuilt payslip loses the 10K LOAN_REPAYMENT
// line and his net silently rises by 10K, while the ledger still shows the
// repayment. Reprocessing must be idempotent in OUTPUT too: a loan that this
// very run repaid stays selected for this run.
import { describe, it, expect } from '@jest/globals';
import { loanBridgeWhere, planLoanRepayment } from '../../src/services/payrollService.js';

describe('N-14 loan bridge selection', () => {
    it('still selects outstanding loans (the ordinary case)', () => {
        const w = loanBridgeWhere(500, 9);
        expect(w.employeeId).toBe(500);
        expect(w.status).toBe('ACTIVE');
        expect(w.OR).toContainEqual({ outstandingMinor: { gt: 0 } });
    });

    it('also selects loans already repaid BY THIS RUN', () => {
        const w = loanBridgeWhere(533, 9);
        expect(w.OR).toContainEqual({
            repayments: { some: { payrollRunId: 9 } },
        });
    });

    it('does not drag in loans repaid by a DIFFERENT run', () => {
        // A loan closed via a July run (or manually) must not resurface in
        // August: only this-run repayments keep the line.
        const w = loanBridgeWhere(533, 9);
        const repaymentsBranch = w.OR.find((b) => b.repayments);
        expect(repaymentsBranch.repayments.some.payrollRunId).toBe(9);
        expect(JSON.stringify(w)).not.toContain('payrollRunId":7');
    });

    it('planLoanRepayment still refuses to double-book the repayment', () => {
        // The write-side guard is the other half: re-process must re-price the
        // LINE but never re-create the LoanRepayment or re-decrement outstanding.
        const planned = planLoanRepayment({
            existing: { id: 99, amountMinor: 1000000n },
            installmentMinor: 1000000n,
            grossLimitMinor: 10000000n,
            usedMinor: 0n,
        });
        expect(planned.skip).toBe(true);
    });
});

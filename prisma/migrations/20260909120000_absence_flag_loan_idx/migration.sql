-- T-0.3 (N-01) + T-1.2 (N-02) — plan 20 Phase 0/1, audit report 19.
-- 1) PayrollRuleConfig.absenceRecoveryEnabled — ships false everywhere; the
--    engine gates the new ABSENCE_RECOVERY line on it. Additive, no data change.
-- 2) LoanRepayment: index for the (loanId, payrollRunId) idempotency lookup.
--    The uniqueness itself is enforced in the application layer (T-1.2) and
--    backfilled to a partial UNIQUE index after prod data reconciliation
--    (T-1.3) — a UNIQUE index now would reject the legitimate NULL-run
--    "Pre-system installment" history rows (3 per loan on loans 5/6/8).

ALTER TABLE "payroll_rule_config"
  ADD COLUMN "absenceRecoveryEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "loan_repayments_loanId_payrollRunId_idx"
  ON "loan_repayments"("loanId", "payrollRunId");

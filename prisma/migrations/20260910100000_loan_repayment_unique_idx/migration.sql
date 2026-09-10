-- Local-parity migration for A4 (plan 25) / [N-02]: partial UNIQUE on
-- (loanId, payrollRunId) excluding legacy NULL-run rows. Production applies
-- scripts/sql/N-02.loan-repayment-unique-index.sql (CONCURRENTLY, outside a
-- transaction); this migration keeps dev/test schemas structurally identical.

DROP INDEX IF EXISTS "loan_repayments_loanId_payrollRunId_idx";

CREATE UNIQUE INDEX "loan_repayments_loanId_payrollRunId_uniq"
  ON "loan_repayments" ("loanId", "payrollRunId")
  WHERE "payrollRunId" IS NOT NULL;

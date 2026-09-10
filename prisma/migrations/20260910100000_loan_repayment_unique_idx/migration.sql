-- Local-parity migration for A4 (plan 25) / [N-02]: partial UNIQUE on
-- (loanId, payrollRunId) excluding legacy NULL-run rows. Production applies
-- scripts/sql/N-02.loan-repayment-unique-index.sql (CONCURRENTLY, outside a
-- transaction); this migration keeps dev/test schemas structurally identical.
--
-- IF NOT EXISTS because production ALREADY carries the unique index (built
-- CONCURRENTLY on 2026-09-10, before this migration was recorded) —
-- migrate:apply must be able to record the migration without erroring.

DROP INDEX IF EXISTS "loan_repayments_loanId_payrollRunId_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "loan_repayments_loanId_payrollRunId_uniq"
  ON "loan_repayments" ("loanId", "payrollRunId")
  WHERE "payrollRunId" IS NOT NULL;

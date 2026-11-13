-- A4 (plan 25) / T-1.2 backfill — [N-02] loan_repayments uniqueness.
--
-- Plan 20 gated this conversion on the T-1.3 reconciliation. Gate passed
-- 2026-09-10 (doc 24 §2 criterion 4: 0 duplicate (loanId, payrollRunId) pairs
-- fleet-wide, 12 repayments all distinct). Re-verify immediately before apply —
-- never trust a stale clean-check:
--
--   SELECT "loanId","payrollRunId",count(*) FROM "loan_repayments"
--   WHERE "payrollRunId" IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;
--
-- Must return ZERO rows before the CREATE below. If it returns rows, STOP —
-- reconcile first (T-1.3 procedure, plan 20).
--
-- CONCURRENTLY (no table lock, cannot run inside a transaction — psql autocommit).
-- Partial predicate keeps legacy NULL-run rows ("Pre-system installment" history)
-- legal while making every run-linked repayment unique per (loan, run).

-- Guard (executed first by the operator; psql \if aborts the file on duplicates):
-- SELECT 1/0 FROM (SELECT 1 FROM "loan_repayments"
--   WHERE "payrollRunId" IS NOT NULL GROUP BY "loanId","payrollRunId"
--   HAVING count(*) > 1 LIMIT 1) d;

DROP INDEX IF EXISTS "loan_repayments_loanId_payrollRunId_idx";

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "loan_repayments_loanId_payrollRunId_uniq"
  ON "loan_repayments" ("loanId", "payrollRunId")
  WHERE "payrollRunId" IS NOT NULL;

-- Post-verify:
-- SELECT indexdef FROM pg_indexes
--   WHERE indexname = 'loan_repayments_loanId_payrollRunId_uniq';
-- Expect: CREATE UNIQUE INDEX ... WHERE "payrollRunId" IS NOT NULL

-- F-DB-01 drift repair — LoanRepayment declares @@index([loanId, payrollRunId])
-- in schema.prisma, but no migration ever created it. Two consequences: the
-- replay-from-zero schema never matched the model, and the next `migrate diff`
-- would generate exactly this statement anyway.
--
-- Additive and non-destructive: no table, column or row is touched. The index
-- serves the payroll-run → repayment lookup (posting deductions reads the
-- repayments attached to one run).
--
-- IF NOT EXISTS so a re-run on a database where the index was created by hand is
-- a no-op rather than an error.
CREATE INDEX IF NOT EXISTS "loan_repayments_loanId_payrollRunId_idx"
  ON "loan_repayments" ("loanId", "payrollRunId");

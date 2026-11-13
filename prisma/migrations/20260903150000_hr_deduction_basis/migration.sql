-- HR-PAYROLL-DEDUCTION-BASIS-01 — what one deducted day is charged against.
--
-- Operator spec 2026-09-03: a deducted day is the FULL monthly salary divided
-- by the CALENDAR days of the month (August: 100,000 / 31 = 3,225.8), not base
-- salary over a fixed 26 working days.
--
-- GROSS = base + fixed allowances, the contracted monthly package.
-- BASIC  = base salary alone.
--
-- Salaries in this fleet are structured basic 45% + allowances 55%, so BASIC
-- charges less than half of GROSS for the same absence. GROSS is the default
-- because under-deducting silently is the worse failure of the two.
--
-- Additive with a default, so existing rows backfill and the previously running
-- image simply does not select the column.
ALTER TABLE "payroll_rule_config"
  ADD COLUMN IF NOT EXISTS "deductionBasis" TEXT NOT NULL DEFAULT 'GROSS';

-- Additive: payroll deduction settings and the minimum-session floor live on the
-- tenant's attendance policy. Defaults equal the values that were hard-coded, so
-- no payslip changes when this is applied.
ALTER TABLE "attendance_policy_config"
  ADD COLUMN "deductMajorThresholdMinutes" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "deductPoolSize" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "deductAbsentDays" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN "deductMissingPunchDays" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN "deductMajorTimingDays" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN "deductPooledMinorDays" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN "minSessionMinutes" INTEGER NOT NULL DEFAULT 5;

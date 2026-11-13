-- Missing check-ins and check-outs that are disapproved or never raised are pooled like minor
-- lateness: every `deductMissingPoolSize` of them, per employee and payroll period, cost
-- `deductMissingPunchDays` (operator, 2026-10-30: three missing punches = one day).
-- Additive. Existing policies keep their saved day values; set deductMissingPunchDays to 1 per company
-- through the attendance policy (a policy still at 0.5 would charge half a day per pool of three).
ALTER TABLE "attendance_policy_config" ADD COLUMN "deductMissingPoolSize" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "attendance_policy_config" ALTER COLUMN "deductMissingPunchDays" SET DEFAULT 1;

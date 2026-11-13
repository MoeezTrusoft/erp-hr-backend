-- Attendance counters are independent under the authoritative policy:
-- LATE has its own 3:1 counter, while MISSING_CHECKIN and
-- MISSING_CHECKOUT share only MISSING_PUNCH. The legacy POOLED_FLOOR bases
-- pooled unrelated categories and could combine late and missing fractions.
UPDATE "payroll_rule_config"
   SET "deductionBasis" = 'GROSS',
       "updatedAt" = NOW();

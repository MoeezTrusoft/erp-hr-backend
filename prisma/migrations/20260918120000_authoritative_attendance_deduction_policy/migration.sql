-- Authoritative attendance deduction policy (2026-09-18)
--
-- 3 late check-ins = 1 day; 3 missing punches (IN or OUT) = 1 day.
-- Early checkout is priced from the evaluator's day_credit (0 = absent,
-- 0.5 = half day), so the EARLY_CHECKOUT occurrence rule must not also charge
-- the same day. A rejected ABSENT request is one full day. Approved requests
-- are excluded by the payroll bridge; pending/no request remains chargeable.

ALTER TABLE "payroll_rule_config"
  ALTER COLUMN "absenceRecoveryEnabled" SET DEFAULT true;

UPDATE "payroll_rule_config"
   SET "absenceRecoveryEnabled" = true,
       "updatedAt" = NOW();

UPDATE "attendance_deduction_rules"
   SET "enabled" = true,
       "triggerCount" = 3,
       "deductionDays" = 1,
       "counterGroup" = NULL,
       "updatedAt" = NOW()
 WHERE "ruleKey" = 'LATE';

UPDATE "attendance_deduction_rules"
   SET "enabled" = true,
       "triggerCount" = 3,
       "deductionDays" = 1,
       "counterGroup" = 'MISSING_PUNCH',
       "updatedAt" = NOW()
 WHERE "ruleKey" IN ('MISSING_CHECKIN', 'MISSING_CHECKOUT');

UPDATE "attendance_deduction_rules"
   SET "enabled" = true,
       "triggerCount" = 1,
       "deductionDays" = 1,
       "counterGroup" = NULL,
       "updatedAt" = NOW()
 WHERE "ruleKey" = 'DISAPPROVED_LEAVE';

-- Early checkout is represented by day_credit and absence recovery. Leaving an
-- occurrence rule enabled would double-charge early departures.
UPDATE "attendance_deduction_rules"
   SET "enabled" = false,
       "updatedAt" = NOW()
 WHERE "ruleKey" = 'EARLY_CHECKOUT';

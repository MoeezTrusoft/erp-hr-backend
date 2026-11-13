-- HR-ATT-POLICY-01 — pooled deduction counters.
--
-- Rules sharing a counterGroup count together, so "3 missed punches of either
-- kind = 1 day" is configuration rather than code, and separating them again is
-- a settings change rather than a migration.
ALTER TABLE "attendance_deduction_rules" ADD COLUMN IF NOT EXISTS "counterGroup" TEXT;

-- HR's stated policy: missing check-in and missing check-out share one counter.
UPDATE "attendance_deduction_rules"
   SET "counterGroup" = 'MISSING_PUNCH'
 WHERE "ruleKey" IN ('MISSING_CHECKIN', 'MISSING_CHECKOUT');

SELECT left("tenantId"::text,8) AS tenant, "ruleKey", "counterGroup", "triggerCount", "deductionDays"
  FROM "attendance_deduction_rules" ORDER BY 1, 2;

-- HR-ATT-POLICY-01 — grants + row-level security for the attendance config tables.
--
-- The 20260901180000 migration created these tables as `postgres`, which left
-- them with neither of the two things every other tenant-owned table here has:
--
--   1. GRANTs. The application connects as `erp` (see DATABASE_URL), so every
--      query failed with "permission denied for table
--      attendance_policy_config" (SQLSTATE 42501). Unit tests all mock Prisma,
--      so this could only surface against the live pod — and it did.
--
--   2. Row-level security. payroll_rule_config runs ENABLE + FORCE ROW LEVEL
--      SECURITY with a tenant_isolation policy; these four had relrowsecurity =
--      false. Tenant isolation would have rested entirely on the application's
--      tenantScope extension, with no database-level guarantee behind it. These
--      tables hold deduction rules that decide pay, so that gap is not
--      acceptable.
--
-- The policy is copied verbatim from payroll_rule_config, including the
-- app.tenant_bypass escape used by SYSTEM jobs and migrations.

-- 1. Grants ----------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "attendance_policy_config",
    "attendance_deduction_rules",
    "attendance_approval_levels",
    "attendance_anomaly_approvals"
TO "erp", "hr_app";

-- SERIAL primary keys need the sequence too, or every INSERT fails.
GRANT USAGE, SELECT ON SEQUENCE
    "attendance_policy_config_id_seq",
    "attendance_deduction_rules_id_seq",
    "attendance_approval_levels_id_seq",
    "attendance_anomaly_approvals_id_seq"
TO "erp", "hr_app";

-- 2. Row-level security ----------------------------------------------------
-- FORCE so the table owner is subject to the policy as well; without it a
-- connection owning the table silently bypasses tenant isolation.
ALTER TABLE "attendance_policy_config"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_policy_config"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "attendance_deduction_rules"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_deduction_rules"    FORCE  ROW LEVEL SECURITY;
ALTER TABLE "attendance_approval_levels"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_approval_levels"    FORCE  ROW LEVEL SECURITY;
ALTER TABLE "attendance_anomaly_approvals"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_anomaly_approvals"  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "attendance_policy_config";
CREATE POLICY tenant_isolation ON "attendance_policy_config"
    USING ("tenantId" = hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
    WITH CHECK ("tenantId" = hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

DROP POLICY IF EXISTS tenant_isolation ON "attendance_deduction_rules";
CREATE POLICY tenant_isolation ON "attendance_deduction_rules"
    USING ("tenantId" = hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
    WITH CHECK ("tenantId" = hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

DROP POLICY IF EXISTS tenant_isolation ON "attendance_approval_levels";
CREATE POLICY tenant_isolation ON "attendance_approval_levels"
    USING ("tenantId" = hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
    WITH CHECK ("tenantId" = hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

DROP POLICY IF EXISTS tenant_isolation ON "attendance_anomaly_approvals";
CREATE POLICY tenant_isolation ON "attendance_anomaly_approvals"
    USING ("tenantId" = hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
    WITH CHECK ("tenantId" = hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

-- 3. Verification ----------------------------------------------------------
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname IN ('attendance_policy_config', 'attendance_deduction_rules',
                  'attendance_approval_levels', 'attendance_anomaly_approvals')
ORDER BY relname;

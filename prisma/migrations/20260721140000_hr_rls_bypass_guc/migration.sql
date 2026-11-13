-- HR RLS fix — add a SYSTEM bypass to the pilot policies.
--
-- The c2_rls_pilot policies were `USING ("tenantId" = hr_current_tenant())` with
-- NO bypass clause. When the app's DATABASE_URL was later re-pointed from a
-- superuser to the non-privileged `erp` role (which OWNS these FORCE-RLS tables),
-- RLS started applying to the app itself — correct for tenant sessions, but it
-- silently broke trusted cross-tenant jobs: a SYSTEM context sets no app.tenant_id,
-- so hr_current_tenant() is NULL and every row is hidden. The review-reminder job,
-- which scans PerformanceReview as SYSTEM, was seeing ZERO reviews fleet-wide.
--
-- Fix (mirrors the Comm design): a row is visible/writable when its tenant matches
-- app.tenant_id (TENANT sessions) OR when app.tenant_bypass='on' (SYSTEM jobs).
-- src/lib/rlsTenant.js sets whichever GUC applies, transaction-locally. Tenant
-- isolation is UNCHANGED for tenant sessions (a tenant request never sets bypass).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['leave_requests', 'Attendance', 'PerformanceReview'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING ("tenantId" = public.hr_current_tenant() '
      || 'OR current_setting(''app.tenant_bypass'', true) = ''on'') '
      || 'WITH CHECK ("tenantId" = public.hr_current_tenant() '
      || 'OR current_setting(''app.tenant_bypass'', true) = ''on'')',
      t
    );
  END LOOP;
END $$;

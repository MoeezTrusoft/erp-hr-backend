-- C.2 / T-P2.6 — complete HR payroll RLS: the 2 reference/lookup tables.
--
-- payroll_earning_types / payroll_deduction_types were held back from
-- hr_rls_pilot_payroll_timesheet pending a global-row check, since a null-tenant
-- lookup row shared across tenants would vanish under FORCE RLS. Diagnostic (run
-- in-cluster) confirmed BOTH tables have 0 null-tenant rows — config is fully
-- per-tenant — so FORCE RLS hides nothing. Same bypass-aware pattern as the rest
-- of the pilot; src/lib/rlsTenant.js adds the 2 MODEL names to RLS_MODELS.

GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_earning_types"   TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_deduction_types" TO hr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['payroll_earning_types', 'payroll_deduction_types'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
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

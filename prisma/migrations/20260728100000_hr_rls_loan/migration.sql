-- HR RLS: Loan + LoanRepayment (added after fleet extend)
-- These tables were created in 20260727162833_loan_management without FORCE-RLS.
-- Uses the same hr_current_tenant() function + bypass GUC as the fleet.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['loans', 'loan_repayments'];
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

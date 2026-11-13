-- C.2 / T-P2.6 — EXTEND the RLS pilot to Payroll + Timesheet transactional tables.
--
-- Follows hr_rls_pilot_extend. Audit verdict: these 9 tables are reached ONLY via
-- the Prisma ORM (no raw SQL), every caller runs in an established tenant context
-- (REST behind establishTenantContext, or MCP tools via mcpCtx), and NO cross-
-- tenant SYSTEM sweep reads them — the app's only SYSTEM contexts (reminder-queue
-- processor, outbox dispatcher) never touch payroll/timesheet; the dispatcher
-- reads only the Outbox table. So enabling FORCE RLS is strictly lower-risk than
-- the review-reminder case (there is no SYSTEM reader to blind). The policy still
-- carries the `OR app.tenant_bypass='on'` clause so any FUTURE SYSTEM job is safe.
--
-- EXCLUDED here: payroll_earning_types / payroll_deduction_types (reference/lookup
-- tables) — pending a null-tenant (global-row) data check, since a global lookup
-- row would become invisible to tenant sessions under FORCE RLS.
--
-- src/lib/rlsTenant.js adds these 9 MODEL names to RLS_MODELS so the extension
-- sets app.tenant_id (tenant ctx) or app.tenant_bypass='on' (SYSTEM ctx)
-- transaction-locally per op. Policy: a row is visible/writable iff its tenantId
-- equals the session tenant (hr_current_tenant()) OR the session is a trusted
-- SYSTEM job. Null-tenant rows stay invisible to tenant sessions (fail-closed).

-- ── grants for the non-privileged proof role (the "leaked connection") ──────
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_runs"        TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_payslips"    TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_earnings"    TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_deductions"  TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_assignments" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_audit_logs"  TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Timesheet"           TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TimeEntry"           TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TimeApproval"        TO hr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

-- ── enable + FORCE RLS and the bypass-aware tenant policy on each table ─────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'payroll_runs', 'payroll_payslips', 'payroll_earnings', 'payroll_deductions',
    'payroll_assignments', 'payroll_audit_logs', 'Timesheet', 'TimeEntry', 'TimeApproval'
  ];
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

-- C.2 / T-P2.6 — EXTEND the RLS pilot to the Tier-1 high-PII tables.
--
-- The c2_rls_pilot migration proved FORCE ROW LEVEL SECURITY on one table per
-- family (leave_requests / Attendance / PerformanceReview); hr_rls_bypass_guc
-- then added the SYSTEM `OR app.tenant_bypass='on'` clause so trusted cross-tenant
-- jobs still read every tenant. This migration rolls the SAME proven pattern onto
-- the three highest-sensitivity tables:
--
--   * bank_details       — account #, IBAN, routing (C4-encrypted at rest)
--   * employment_terms   — base salary, bonus, equity (C4-encrypted at rest)
--   * EmergencyContacts  — next-of-kin PII (no @@map → PascalCase table name)
--
-- Safety (audited before enabling): each table is reached ONLY through the Prisma
-- ORM (no raw SQL), every caller is already gated by the tenantScope deny-by-
-- default extension (so a tenant OR system context is always established), and no
-- background job/dispatcher/outbox scans them. src/lib/rlsTenant.js adds these
-- three MODEL names to RLS_MODELS so the extension sets app.tenant_id (tenant
-- ctx) or app.tenant_bypass='on' (SYSTEM ctx) transaction-locally on each op.
--
-- Policy (mirrors the bypass-aware pilot): a row is visible/writable iff its
-- tenantId equals the session tenant (hr_current_tenant()) OR the session is a
-- trusted SYSTEM job (app.tenant_bypass='on'). Null-tenant legacy rows stay
-- invisible to tenant sessions (fail-closed), reachable only under bypass.

-- ── grants for the non-privileged proof role (the "leaked connection") ──────
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_details"       TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "employment_terms"   TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "EmergencyContacts"  TO hr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

-- ── enable + FORCE RLS and the bypass-aware tenant policy on each table ─────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['bank_details', 'employment_terms', 'EmergencyContacts'];
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

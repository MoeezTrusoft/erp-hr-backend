-- Payroll Setup → Pay Rules: discrete tenant-owned policy rules (array on the
-- screen), distinct from the singleton payroll_rule_config toggles. Each row is
-- a human title + description; the backend camel-cases the title into a stable
-- ruleKey (unique per tenant). Additive, no data loss. FORCE-RLS via the fleet
-- hr_current_tenant() create-stamp pattern (same as 20260724180000).

-- ── payroll_rules ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payroll_rules" (
  "id"          SERIAL PRIMARY KEY,
  "ruleKey"     TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "description" TEXT,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "status"      "ConfigStatus" NOT NULL DEFAULT 'DRAFT',
  "version"     INTEGER NOT NULL DEFAULT 1,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"    UUID DEFAULT public.hr_current_tenant()
);
CREATE INDEX IF NOT EXISTS "payroll_rules_tenantId_idx" ON "payroll_rules"("tenantId");
-- ruleKey unique per tenant (NULLs are distinct in Postgres, so cross-null rows never collide).
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_rules_tenantId_ruleKey_key" ON "payroll_rules"("tenantId","ruleKey");

-- ── FORCE ROW LEVEL SECURITY ────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_rules']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hr_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'') '
      'WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'')',
      t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

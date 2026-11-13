-- Payroll Setup config screen. Additive: 4 new enums, band fields on GradeLevel,
-- baseTax+status on tax_rates, and 6 new config tables (FORCE-RLS via the fleet
-- hr_current_tenant() create-stamp pattern). No data loss.

-- ── Enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "ComputationType" AS ENUM ('FIXED','PERCENTAGE','FORMULA'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ConfigStatus" AS ENUM ('DRAFT','PUBLISHED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "RowStatus" AS ENUM ('ACTIVE','INACTIVE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "CalendarAnchor" AS ENUM ('FIXED_DATE','FIRST_OF_MONTH','LAST_OF_MONTH'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── GradeLevel: salary band ─────────────────────────────────────────────────
ALTER TABLE "GradeLevel"
  ADD COLUMN IF NOT EXISTS "minSalary"    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "midSalary"    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "maxSalary"    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "bandCurrency" TEXT;

-- ── tax_rates: FBR baseTax + status ─────────────────────────────────────────
ALTER TABLE "tax_rates" ADD COLUMN IF NOT EXISTS "baseTax" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "tax_rates" ADD COLUMN IF NOT EXISTS "status" "RowStatus" NOT NULL DEFAULT 'ACTIVE';

-- ── salary_components ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "salary_components" (
  "id"           SERIAL PRIMARY KEY,
  "code"         TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "type"         "PayElementType" NOT NULL,
  "computation"  "ComputationType" NOT NULL DEFAULT 'FIXED',
  "value"        DOUBLE PRECISION,
  "formula"      TEXT,
  "taxable"      BOOLEAN NOT NULL DEFAULT true,
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "gradeLevelId" INTEGER,
  "status"       "ConfigStatus" NOT NULL DEFAULT 'DRAFT',
  "version"      INTEGER NOT NULL DEFAULT 1,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"     UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "salary_components_gradeLevelId_fkey" FOREIGN KEY ("gradeLevelId") REFERENCES "GradeLevel"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "salary_components_tenantId_idx" ON "salary_components"("tenantId");
CREATE INDEX IF NOT EXISTS "salary_components_code_idx" ON "salary_components"("code");
CREATE INDEX IF NOT EXISTS "salary_components_gradeLevelId_idx" ON "salary_components"("gradeLevelId");

-- ── payroll_calendars ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payroll_calendars" (
  "id"                  SERIAL PRIMARY KEY,
  "payFrequency"        "PayFrequency" NOT NULL DEFAULT 'MONTHLY',
  "periodStartAnchor"   "CalendarAnchor" NOT NULL DEFAULT 'FIRST_OF_MONTH',
  "periodStartDate"     TIMESTAMP(3),
  "periodEndAnchor"     "CalendarAnchor" NOT NULL DEFAULT 'LAST_OF_MONTH',
  "periodEndDate"       TIMESTAMP(3),
  "attendanceCutoff"    TIMESTAMP(3),
  "approvalsClose"      TIMESTAMP(3),
  "payDateAnchor"       "CalendarAnchor" NOT NULL DEFAULT 'LAST_OF_MONTH',
  "payDate"             TIMESTAMP(3),
  "payDateWeekendShift" BOOLEAN NOT NULL DEFAULT true,
  "status"              "ConfigStatus" NOT NULL DEFAULT 'DRAFT',
  "version"             INTEGER NOT NULL DEFAULT 1,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"            UUID DEFAULT public.hr_current_tenant()
);
CREATE INDEX IF NOT EXISTS "payroll_calendars_tenantId_idx" ON "payroll_calendars"("tenantId");

-- ── payroll_approval_matrix ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payroll_approval_matrix" (
  "id"                SERIAL PRIMARY KEY,
  "level"             INTEGER NOT NULL,
  "role"              TEXT NOT NULL,
  "approverId"        INTEGER,
  "thresholdRequired" BOOLEAN NOT NULL DEFAULT false,
  "thresholdAmount"   DOUBLE PRECISION,
  "autoEscalateAfter" TIMESTAMP(3),
  "status"            "RowStatus" NOT NULL DEFAULT 'ACTIVE',
  "version"           INTEGER NOT NULL DEFAULT 1,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"          UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "payroll_approval_matrix_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "payroll_approval_matrix_tenantId_idx" ON "payroll_approval_matrix"("tenantId");
CREATE INDEX IF NOT EXISTS "payroll_approval_matrix_level_idx" ON "payroll_approval_matrix"("level");

-- ── payroll_rule_config ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payroll_rule_config" (
  "id"                      SERIAL PRIMARY KEY,
  "midMonthJoinerProration" BOOLEAN NOT NULL DEFAULT true,
  "midMonthExitSettlement"  BOOLEAN NOT NULL DEFAULT true,
  "lwpRecovery"             BOOLEAN NOT NULL DEFAULT true,
  "complianceHold"          BOOLEAN NOT NULL DEFAULT true,
  "garnishmentRecovery"     BOOLEAN NOT NULL DEFAULT true,
  "garnishmentCapPct"       DOUBLE PRECISION NOT NULL DEFAULT 33,
  "offCycleRelease"         BOOLEAN NOT NULL DEFAULT true,
  "status"                  "ConfigStatus" NOT NULL DEFAULT 'DRAFT',
  "version"                 INTEGER NOT NULL DEFAULT 1,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"                UUID DEFAULT public.hr_current_tenant()
);
CREATE INDEX IF NOT EXISTS "payroll_rule_config_tenantId_idx" ON "payroll_rule_config"("tenantId");

-- ── payroll_config_meta ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payroll_config_meta" (
  "id"               SERIAL PRIMARY KEY,
  "status"           "ConfigStatus" NOT NULL DEFAULT 'DRAFT',
  "draftVersion"     INTEGER NOT NULL DEFAULT 1,
  "publishedVersion" INTEGER NOT NULL DEFAULT 0,
  "hasUnpublished"   BOOLEAN NOT NULL DEFAULT true,
  "publishedAt"      TIMESTAMP(3),
  "publishedById"    INTEGER,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"         UUID DEFAULT public.hr_current_tenant()
);
CREATE INDEX IF NOT EXISTS "payroll_config_meta_tenantId_idx" ON "payroll_config_meta"("tenantId");

-- ── payroll_config_snapshots ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payroll_config_snapshots" (
  "id"            SERIAL PRIMARY KEY,
  "version"       INTEGER NOT NULL,
  "config"        JSONB NOT NULL,
  "publishedById" INTEGER,
  "publishedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"      UUID DEFAULT public.hr_current_tenant()
);
CREATE INDEX IF NOT EXISTS "payroll_config_snapshots_tenantId_idx" ON "payroll_config_snapshots"("tenantId");
CREATE INDEX IF NOT EXISTS "payroll_config_snapshots_version_idx" ON "payroll_config_snapshots"("version");

-- ── FORCE ROW LEVEL SECURITY on the 6 new tables ────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['salary_components','payroll_calendars','payroll_approval_matrix','payroll_rule_config','payroll_config_meta','payroll_config_snapshots']
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

-- HR-PAYROLL-EMPLOYMENT-PERIOD-01 — when an employee was actually employed.
--
-- Employee has hire_date and no leaving date, so payroll could not prorate a
-- leaver (it read employee.term_date, which does not exist) and could not
-- represent a re-hire at all. One row per spell; end_date NULL = still employed.

CREATE TABLE IF NOT EXISTS "employment_periods" (
    "id"          SERIAL       NOT NULL,
    "tenantId"    UUID,
    "employeeId"  INTEGER      NOT NULL,
    "startDate"   TIMESTAMP(3) NOT NULL,
    "endDate"     TIMESTAMP(3),
    "reason"      TEXT,
    "note"        TEXT,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employment_periods_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "employment_periods_tenantId_employeeId_startDate_idx"
    ON "employment_periods" ("tenantId", "employeeId", "startDate");

DO $$ BEGIN
    ALTER TABLE "employment_periods"
        ADD CONSTRAINT "employment_periods_employeeId_fkey"
        FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill one open-ended period per employee from the tenure anchor, so the
-- table is never the reason somebody's salary changes. Employees with no
-- hire_date are skipped: proration treats "no rows" as a full month, which is
-- exactly today's behaviour for them.
INSERT INTO "employment_periods" ("tenantId", "employeeId", "startDate", "reason", "updated_at")
SELECT e."tenant_id", e."id", COALESCE(e."hire_date", e."joining_date"),
       'Backfilled from hire_date (HR-PAYROLL-EMPLOYMENT-PERIOD-01)', CURRENT_TIMESTAMP
FROM "Employee" e
WHERE COALESCE(e."hire_date", e."joining_date") IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM "employment_periods" p WHERE p."employeeId" = e."id"
  );

-- ── FORCE ROW LEVEL SECURITY ────────────────────────────────────────────────
-- Required in the same migration as the model's entry in RLS_MODELS. The prisma
-- extension only SETS the GUC; the filtering is these policies. A table in
-- RLS_MODELS with no policy is not scoped and raises no error — it silently
-- returns every tenant's rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON "employment_periods" TO hr_app;
ALTER TABLE "employment_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employment_periods" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "employment_periods";
CREATE POLICY tenant_isolation ON "employment_periods"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

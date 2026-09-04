-- HR-ATT-DEVICE-ENROLMENT-01 — which device id belonged to whom, and when.
--
-- Employee.biometric_id holds ONE id, so a re-enrolled employee's new id matches
-- nobody and their punches never reach Attendance. A multi-value list would not
-- be safe either: device ids get REUSED, so a list would claim a later holder's
-- punches for the original owner. Enrolments are period-scoped instead.

CREATE TABLE IF NOT EXISTS "employee_device_enrolments" (
    "id"            SERIAL       NOT NULL,
    "tenantId"      UUID,
    "employeeId"    INTEGER      NOT NULL,
    "deviceUserId"  VARCHAR(64)  NOT NULL,
    "sn"            VARCHAR(64),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo"   TIMESTAMP(3),
    "note"          TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_device_enrolments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "employee_device_enrolments_tenant_device_from_idx"
    ON "employee_device_enrolments" ("tenantId", "deviceUserId", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "employee_device_enrolments_tenant_employee_from_idx"
    ON "employee_device_enrolments" ("tenantId", "employeeId", "effectiveFrom");

DO $$ BEGIN
    ALTER TABLE "employee_device_enrolments"
        ADD CONSTRAINT "employee_device_enrolments_employeeId_fkey"
        FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- NOTE: no backfill here. The equivalent INSERT ... SELECT FROM "Employee" in
-- 20260904160000_hr_employment_period silently inserted ZERO rows and reported
-- success, because Employee carries FORCE ROW LEVEL SECURITY and a migration
-- runs with neither app.tenant_id nor app.tenant_bypass set, so the SELECT saw
-- an empty table. A migration cannot be trusted to read an RLS table. The
-- backfill runs from the application instead — scripts/backfill-device-enrolments.mjs.

-- ── FORCE ROW LEVEL SECURITY ────────────────────────────────────────────────
-- Ships with the RLS_MODELS entry in the same commit: the prisma extension only
-- SETS the tenant GUC, the filtering is this policy, and a model listed without
-- one is unscoped and raises no error.
GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_device_enrolments" TO hr_app;
ALTER TABLE "employee_device_enrolments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_device_enrolments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "employee_device_enrolments";
CREATE POLICY tenant_isolation ON "employee_device_enrolments"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

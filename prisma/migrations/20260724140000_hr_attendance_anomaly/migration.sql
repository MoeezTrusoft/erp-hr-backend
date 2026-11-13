-- Timesheet screen support + shared Attendance-anomaly entity.
--
-- Additive only: StatusAttendance +HALF_DAY, Attendance.work_mode, and a new
-- attendance_anomalies table (the "Inform Abnormality" / time-correction feed,
-- shared by the Timesheet + Leave & Anomaly screens). FORCE-RLS on the new table
-- via the fleet hr_current_tenant() create-stamp pattern.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot be used in the same transaction that
-- references the new value; this migration is applied statement-by-statement
-- (autocommit), and every statement is idempotent, so re-runs are safe.

-- ── StatusAttendance +HALF_DAY ──────────────────────────────────────────────
ALTER TYPE "StatusAttendance" ADD VALUE IF NOT EXISTS 'HALF_DAY';

-- ── Attendance.work_mode (WFH/Remote KPI) ───────────────────────────────────
ALTER TABLE "Attendance" ADD COLUMN IF NOT EXISTS "work_mode" TEXT;

-- ── Anomaly enums ───────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "AnomalyType" AS ENUM ('LATE_CHECKIN','MISSING_CHECKIN','MISSING_CHECKOUT','EARLY_CHECKOUT','ABSENT','OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "AnomalyStatus" AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── attendance_anomalies ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "attendance_anomalies" (
  "id"         SERIAL PRIMARY KEY,
  "employeeId" INTEGER NOT NULL,
  "type"       "AnomalyType" NOT NULL,
  "reason"     TEXT,
  "detail"     TEXT,
  "date"       TIMESTAMP(3),
  "fromTime"   TIMESTAMP(3),
  "toTime"     TIMESTAMP(3),
  "status"     "AnomalyStatus" NOT NULL DEFAULT 'PENDING',
  "reviewerId" INTEGER,
  "reviewNote" TEXT,
  "decidedAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"   UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "attendance_anomalies_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "attendance_anomalies_tenantId_idx" ON "attendance_anomalies"("tenantId");
CREATE INDEX IF NOT EXISTS "attendance_anomalies_employeeId_idx" ON "attendance_anomalies"("employeeId");
CREATE INDEX IF NOT EXISTS "attendance_anomalies_status_idx" ON "attendance_anomalies"("status");

-- ── FORCE ROW LEVEL SECURITY ────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "attendance_anomalies" TO hr_app;
ALTER TABLE "attendance_anomalies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_anomalies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "attendance_anomalies";
CREATE POLICY tenant_isolation ON "attendance_anomalies"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

-- HR-ATT-ONCALL-01 — HR calls an employee in on a rostered day off (weekend
-- on-call). One row per employee-day. workingDay.service gives the date
-- precedence over the rostered off-day / rotation rest, so the day becomes a
-- working day: punches score normally and a no-show is an ordinary ABSENT
-- day, charged by the existing deduction path — no anomaly form in the way.
--
-- The matching RLS_MODELS entry ships with the code that reads it; a table
-- with FORCE RLS and no policy silently returns nothing.

CREATE TABLE IF NOT EXISTS "attendance_call_ins" (
    "id"         SERIAL       NOT NULL,
    "tenantId"   UUID,
    "employeeId" INTEGER      NOT NULL,
    "date"       TIMESTAMP(3) NOT NULL,
    "reason"     TEXT,
    "calledBy"   TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "attendance_call_ins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "attendance_call_ins_day_key"
    ON "attendance_call_ins" ("tenantId", "employeeId", "date");

CREATE INDEX IF NOT EXISTS "attendance_call_ins_tenant_date_idx"
    ON "attendance_call_ins" ("tenantId", "date");

DO $$ BEGIN
    ALTER TABLE "attendance_call_ins"
        ADD CONSTRAINT "attendance_call_ins_employeeId_fkey"
        FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── FORCE ROW LEVEL SECURITY ────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "attendance_call_ins" TO hr_app;
ALTER TABLE "attendance_call_ins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_call_ins" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "attendance_call_ins";
CREATE POLICY tenant_isolation ON "attendance_call_ins"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

-- HR-ATT-DEVICE-INTAKE-01 — raw biometric-device punch store (ADMS/iclock push).
-- Append-only source of truth; Attendance (the daily roll-up) is derived from it.

CREATE TABLE "attendance_device_punches" (
    "id"           SERIAL       NOT NULL,
    "sn"           VARCHAR(64)  NOT NULL,
    "deviceUserId" VARCHAR(64)  NOT NULL,
    "punchedAt"    TIMESTAMP(3) NOT NULL,
    "status"       INTEGER      NOT NULL DEFAULT 0,
    "verifyMode"   INTEGER      NOT NULL DEFAULT 0,
    "workCode"     INTEGER      NOT NULL DEFAULT 0,
    "employeeId"   INTEGER,
    "rawLine"      TEXT,
    "ingestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- create-stamp from the intake tenant context, same net as the RLS fleet
    "tenantId"     UUID DEFAULT public.hr_current_tenant(),

    CONSTRAINT "attendance_device_punches_pkey" PRIMARY KEY ("id")
);

-- Idempotency: the device re-pushes the same rows on reconnect.
CREATE UNIQUE INDEX "attendance_device_punch_natural_key"
    ON "attendance_device_punches" ("tenantId", "sn", "deviceUserId", "punchedAt", "status");

CREATE INDEX "attendance_device_punch_user_time_idx"
    ON "attendance_device_punches" ("tenantId", "deviceUserId", "punchedAt" DESC);

CREATE INDEX "attendance_device_punch_emp_time_idx"
    ON "attendance_device_punches" ("tenantId", "employeeId", "punchedAt" DESC);

-- FORCE ROW LEVEL SECURITY — same hr_current_tenant() + bypass GUC as the fleet.
ALTER TABLE "attendance_device_punches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_device_punches" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "attendance_device_punches";
CREATE POLICY tenant_isolation ON "attendance_device_punches"
    USING ("tenantId" = public.hr_current_tenant()
        OR current_setting('app.tenant_bypass', true) = 'on')
    WITH CHECK ("tenantId" = public.hr_current_tenant()
        OR current_setting('app.tenant_bypass', true) = 'on');

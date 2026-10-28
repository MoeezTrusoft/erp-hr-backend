-- ATT-DEVICE-ACCESS-01 — company-to-company device access requests.
--
-- Additive only: one new table, no change to existing tables. A requesting
-- company (`tenantId`) asks a device-owning company (`ownerTenantId`) to use a
-- registered capture device; approval adds the requester to that device's
-- "allowedTenantIds". Both companies must be able to read the request, so the
-- row-level policy admits either side.
CREATE TABLE "attendance_device_access_requests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ownerTenantId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "sn" VARCHAR(64) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "endedBy" TEXT,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "attendance_device_access_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_device_access_state" CHECK ("state" IN ('PENDING','APPROVED','REJECTED','WITHDRAWN','REVOKED')),
    CONSTRAINT "attendance_device_access_other_company" CHECK ("tenantId" <> "ownerTenantId")
);

CREATE INDEX "attendance_device_access_requests_tenantId_state_idx" ON "attendance_device_access_requests"("tenantId", "state");
CREATE INDEX "attendance_device_access_requests_ownerTenantId_state_idx" ON "attendance_device_access_requests"("ownerTenantId", "state");
CREATE INDEX "attendance_device_access_requests_deviceId_tenantId_state_idx" ON "attendance_device_access_requests"("deviceId", "tenantId", "state");
-- At most one open (pending or approved) request per device and company.
CREATE UNIQUE INDEX "attendance_device_access_requests_open_key" ON "attendance_device_access_requests"("deviceId", "tenantId") WHERE "state" IN ('PENDING','APPROVED');

ALTER TABLE "attendance_device_access_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_device_access_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY device_access_parties ON "attendance_device_access_requests"
  USING ("tenantId" = public.hr_current_tenant() OR "ownerTenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR "ownerTenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

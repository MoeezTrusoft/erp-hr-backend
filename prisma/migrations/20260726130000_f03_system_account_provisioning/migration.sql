-- F-03 / ARCH-00 P-04/P-07/P-12 / ARCH-01 §3.5, §7-§9
CREATE TYPE "SystemAccountProvisioningStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'RETRY_WAIT', 'SUCCEEDED', 'TERMINAL_FAILED'
);

CREATE TABLE "system_account_provisioning" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL,
  "status" "SystemAccountProvisioningStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" UUID NOT NULL,
  "payloadFingerprint" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "actor" JSONB NOT NULL,
  "correlationId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "claimedBy" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "rbacUserId" TEXT,
  "result" JSONB,
  "lastError" TEXT,
  "lastErrorCode" TEXT,
  "lastHttpStatus" INTEGER,
  "manualRetryCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "system_account_provisioning_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "system_account_provisioning_tenantId_employeeId_key"
  ON "system_account_provisioning"("tenantId", "employeeId");
CREATE UNIQUE INDEX "system_account_provisioning_tenantId_idempotencyKey_key"
  ON "system_account_provisioning"("tenantId", "idempotencyKey");
CREATE INDEX "system_account_provisioning_status_nextAttemptAt_claimExpiresAt_idx"
  ON "system_account_provisioning"("status", "nextAttemptAt", "claimExpiresAt");
CREATE INDEX "system_account_provisioning_tenantId_status_updatedAt_idx"
  ON "system_account_provisioning"("tenantId", "status", "updatedAt");

GRANT SELECT, INSERT, UPDATE, DELETE ON "system_account_provisioning" TO hr_app;
ALTER TABLE "system_account_provisioning" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "system_account_provisioning" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "system_account_provisioning"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

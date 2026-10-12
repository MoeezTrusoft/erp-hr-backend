-- AlterTable
ALTER TABLE "attendance_device_punches" ADD COLUMN     "captureEventId" UUID,
ADD COLUMN     "enrolmentId" INTEGER,
ADD COLUMN     "localTime" TEXT,
ADD COLUMN     "occurredAt" TIMESTAMP(3),
ADD COLUMN     "timeZone" TEXT;

-- CreateTable
CREATE TABLE "attendance_capture_devices" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sn" VARCHAR(64) NOT NULL,
    "name" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "allowedTenantIds" UUID[],
    "credentialHash" TEXT,
    "legacyKeyAllowed" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "clockOffsetSeconds" INTEGER,
    "staleAfterMinutes" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_capture_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_capture_receipts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "sn" TEXT,
    "requestKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "actorId" TEXT,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_capture_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_capture_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sn" TEXT NOT NULL,
    "deviceUserId" TEXT,
    "raw" JSONB NOT NULL,
    "parsed" JSONB,
    "employeeId" INTEGER,
    "enrolmentId" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "result" JSONB,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_capture_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_capture_audit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "eventId" UUID,
    "receiptId" UUID,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_capture_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_import_batches" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "previewToken" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "results" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PREVIEW',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_capture_devices_sn_key" ON "attendance_capture_devices"("sn");

-- CreateIndex
CREATE INDEX "attendance_capture_devices_tenantId_active_idx" ON "attendance_capture_devices"("tenantId", "active");

-- CreateIndex
CREATE INDEX "attendance_capture_receipts_tenantId_createdAt_idx" ON "attendance_capture_receipts"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_capture_receipts_tenantId_source_requestKey_key" ON "attendance_capture_receipts"("tenantId", "source", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_capture_events_fingerprint_key" ON "attendance_capture_events"("fingerprint");

-- CreateIndex
CREATE INDEX "attendance_capture_events_state_nextAttemptAt_createdAt_idx" ON "attendance_capture_events"("state", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "attendance_capture_events_tenantId_state_id_idx" ON "attendance_capture_events"("tenantId", "state", "id");

-- CreateIndex
CREATE INDEX "attendance_capture_events_tenantId_employeeId_createdAt_idx" ON "attendance_capture_events"("tenantId", "employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "attendance_capture_audit_tenantId_eventId_createdAt_idx" ON "attendance_capture_audit"("tenantId", "eventId", "createdAt");

-- CreateIndex
CREATE INDEX "attendance_import_batches_tenantId_createdAt_idx" ON "attendance_import_batches"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_device_punches_captureEventId_key" ON "attendance_device_punches"("captureEventId");

-- Tenant isolation applies to evidence, receipts, devices, audit and imports.
DO $$ DECLARE tab TEXT; BEGIN
  FOREACH tab IN ARRAY ARRAY['attendance_capture_devices','attendance_capture_receipts','attendance_capture_events','attendance_capture_audit','attendance_import_batches'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'')', tab);
  END LOOP;
END $$;
ALTER TABLE attendance_capture_events ADD CONSTRAINT capture_receipt_fk FOREIGN KEY ("receiptId") REFERENCES attendance_capture_receipts(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_device_punches ADD CONSTRAINT capture_event_fk FOREIGN KEY ("captureEventId") REFERENCES attendance_capture_events(id);
ALTER TABLE attendance_capture_events ADD CONSTRAINT capture_state_valid CHECK (state IN ('PENDING','PROCESSING','PROCESSED','NEEDS_REVIEW','FAILED','DISMISSED'));
ALTER TABLE attendance_capture_devices ADD CONSTRAINT capture_stale_threshold CHECK ("staleAfterMinutes" BETWEEN 1 AND 10080);
CREATE FUNCTION protect_attendance_capture_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD."deviceUserId" IS DISTINCT FROM NEW."deviceUserId" OR OLD.raw IS DISTINCT FROM NEW.raw OR OLD.fingerprint IS DISTINCT FROM NEW.fingerprint OR OLD.source IS DISTINCT FROM NEW.source OR OLD.sn IS DISTINCT FROM NEW.sn OR OLD."receiptId" IS DISTINCT FROM NEW."receiptId" OR OLD.parsed IS DISTINCT FROM NEW.parsed THEN
    RAISE EXCEPTION 'Original attendance evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_capture_evidence_immutable BEFORE UPDATE ON attendance_capture_events FOR EACH ROW EXECUTE FUNCTION protect_attendance_capture_evidence();

ALTER TABLE attendance_capture_devices ADD COLUMN "clockSampledAt" TIMESTAMP(3), ADD COLUMN "lastHealthState" TEXT;

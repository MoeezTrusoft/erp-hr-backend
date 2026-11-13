CREATE TABLE "AttendanceAcceptanceSite" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "slot" TEXT NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'DRAFT', "version" INTEGER NOT NULL DEFAULT 1,
 "payload" JSONB NOT NULL, "contentHash" TEXT NOT NULL, "editorUserIds" JSONB NOT NULL,
 "createdByCode" TEXT NOT NULL, "createdByUserId" INTEGER NOT NULL,
 "managerCode" TEXT, "managerUserId" INTEGER,
 "technicalByCode" TEXT, "technicalByUserId" INTEGER, "technicalHash" TEXT,
 "verifiedByCode" TEXT, "verifiedByUserId" INTEGER, "verifiedHash" TEXT,
 "approvedByCode" TEXT, "approvedByUserId" INTEGER, "approvedHash" TEXT,
 "approvedAt" TIMESTAMP(3), "activatedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL

);
CREATE UNIQUE INDEX "AttendanceAcceptanceSite_tenantId_slot_key" ON "AttendanceAcceptanceSite"("tenantId","slot");
CREATE INDEX "AttendanceAcceptanceSite_tenantId_state_idx" ON "AttendanceAcceptanceSite"("tenantId","state");
CREATE TABLE "AttendanceAcceptanceAudit" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "siteRef" UUID NOT NULL,
 "version" INTEGER NOT NULL, "action" TEXT NOT NULL, "actorCode" TEXT NOT NULL,
 "actorUserId" INTEGER NOT NULL, "payload" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AttendanceAcceptanceAudit_tenantId_siteRef_version_key" ON "AttendanceAcceptanceAudit"("tenantId","siteRef","version");
CREATE TABLE "AttendanceAcceptanceEvidence" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "siteRef" UUID NOT NULL,
 "runKey" TEXT NOT NULL, "payload" JSONB NOT NULL, "content" TEXT NOT NULL,
 "uploadedByCode" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AttendanceAcceptanceEvidence_tenantId_siteRef_idx" ON "AttendanceAcceptanceEvidence"("tenantId","siteRef");
-- ACCEPTANCE_SECURITY: also installed by the isolated test-database preparer.
ALTER TABLE "AttendanceAcceptanceSite" ADD CONSTRAINT acceptance_slot CHECK ("slot" IN ('S01','S02','S03','S04','S05','S06','S07'));
ALTER TABLE "AttendanceAcceptanceSite" ADD CONSTRAINT acceptance_state CHECK ("state" IN ('DRAFT','LINE_MANAGER','HR','MANAGEMENT','APPROVED','ACTIVE','SUSPENDED','REJECTED'));
ALTER TABLE "AttendanceAcceptanceSite" ADD CONSTRAINT acceptance_technical CHECK ("state" NOT IN ('LINE_MANAGER','HR','MANAGEMENT','APPROVED','ACTIVE') OR ("technicalByUserId" IS NOT NULL AND "technicalHash" IS NOT NULL AND "technicalHash"="contentHash" AND NOT ("editorUserIds" @> jsonb_build_array("technicalByUserId"))));
ALTER TABLE "AttendanceAcceptanceSite" ADD CONSTRAINT acceptance_verified CHECK ("state" NOT IN ('MANAGEMENT','APPROVED','ACTIVE') OR
  ("verifiedByUserId" IS NOT NULL AND "verifiedHash" IS NOT NULL AND "verifiedHash"="contentHash" AND "verifiedByUserId"<>"createdByUserId" AND NOT ("editorUserIds" @> jsonb_build_array("verifiedByUserId"))));
ALTER TABLE "AttendanceAcceptanceSite" ADD CONSTRAINT acceptance_approved CHECK ("state" NOT IN ('APPROVED','ACTIVE') OR
  ("approvedByUserId" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedHash" IS NOT NULL AND "managerUserId" IS NOT NULL AND "approvedHash"="contentHash" AND "approvedByUserId"<>"verifiedByUserId" AND "approvedByUserId"<>"managerUserId" AND NOT ("editorUserIds" @> jsonb_build_array("approvedByUserId"))));
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['AttendanceAcceptanceSite','AttendanceAcceptanceAudit','AttendanceAcceptanceEvidence'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY acceptance_tenant ON %I USING ("tenantId"=public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'')',tab);
 END LOOP;
END $$;
CREATE TRIGGER acceptance_audit_immutable BEFORE UPDATE OR DELETE ON "AttendanceAcceptanceAudit" FOR EACH ROW EXECUTE FUNCTION hr_setup_append_only();
CREATE TRIGGER acceptance_evidence_immutable BEFORE UPDATE OR DELETE ON "AttendanceAcceptanceEvidence" FOR EACH ROW EXECUTE FUNCTION hr_setup_append_only();
CREATE FUNCTION attendance_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Acceptance history cannot be deleted'; END IF;
 IF NEW."tenantId"<>OLD."tenantId" OR NEW.slot<>OLD.slot OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Acceptance identity or revision conflict'; END IF;
 IF OLD.state IN ('LINE_MANAGER','MANAGEMENT','APPROVED','ACTIVE') AND NEW.payload<>OLD.payload THEN RAISE EXCEPTION 'Return acceptance to preparation before editing evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_acceptance_guard BEFORE UPDATE OR DELETE ON "AttendanceAcceptanceSite" FOR EACH ROW EXECUTE FUNCTION attendance_acceptance_guard();
ALTER TABLE attendance_capture_devices ADD COLUMN "acceptanceSiteRef" UUID;
ALTER TABLE attendance_capture_devices ADD COLUMN "acceptanceMode" TEXT;
ALTER TABLE attendance_capture_devices ALTER COLUMN active SET DEFAULT false;
-- Existing live capture is not silently interrupted or labelled accepted. New
-- activations and reactivations must use the reviewed acceptance workflow.
CREATE FUNCTION attendance_device_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND (NEW.sn,NEW."tenantId",NEW."siteId",NEW."timeZone",NEW."allowedTenantIds",NEW."biometricSite",NEW."biometricPublicKey",NEW."fingerprintPadLevel",NEW."fingerprintPadValidated") IS DISTINCT FROM (OLD.sn,OLD."tenantId",OLD."siteId",OLD."timeZone",OLD."allowedTenantIds",OLD."biometricSite",OLD."biometricPublicKey",OLD."fingerprintPadLevel",OLD."fingerprintPadValidated") THEN
  NEW.active:=false; NEW."acceptanceSiteRef":=NULL; NEW."acceptanceMode":=NULL;
 END IF;
 IF NEW.active AND (TG_OP='INSERT' OR NOT OLD.active OR NEW."acceptanceSiteRef" IS DISTINCT FROM OLD."acceptanceSiteRef" OR NEW."acceptanceMode" IS DISTINCT FROM OLD."acceptanceMode") THEN
  IF NEW."acceptanceMode" IS NULL OR NEW."acceptanceMode" NOT IN ('AUTOMATED','SUPERVISED') OR NEW."acceptanceSiteRef" IS NULL OR current_setting('app.attendance_acceptance',true) IS DISTINCT FROM NEW."acceptanceSiteRef"::text OR NOT EXISTS (
   SELECT 1 FROM "AttendanceAcceptanceSite" s WHERE s.id=NEW."acceptanceSiteRef" AND s."tenantId"=NEW."tenantId" AND s.state IN ('APPROVED','ACTIVE') AND s."approvedHash"=s."contentHash"
  ) THEN RAISE EXCEPTION 'HR verification and Management-approved onsite acceptance required before device activation'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_device_activation_guard BEFORE INSERT OR UPDATE ON attendance_capture_devices FOR EACH ROW EXECUTE FUNCTION attendance_device_activation_guard();

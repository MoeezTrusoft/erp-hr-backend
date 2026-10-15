ALTER TABLE "SeparationPolicy" ADD COLUMN "approvalReviewRef" UUID;
CREATE TABLE "HrSetupReview" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "kind" TEXT NOT NULL,
 "subjectKey" TEXT NOT NULL, "employeeCode" TEXT, "state" TEXT NOT NULL DEFAULT 'DRAFT',
 "version" INTEGER NOT NULL DEFAULT 1, "payload" JSONB NOT NULL, "source" JSONB NOT NULL,
 "contentHash" TEXT NOT NULL, "preparedByCode" TEXT NOT NULL, "preparedByUserId" INTEGER NOT NULL,
 "editorUserIds" JSONB NOT NULL, "approvedByCode" TEXT, "approvedByUserId" INTEGER,
 "approvedHash" TEXT, "approvedAt" TIMESTAMP(3), "activatedAt" TIMESTAMP(3),
 "activationPlan" JSONB, "failure" TEXT, "reservedEmployeeId" INTEGER, "reservedUserId" INTEGER,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "HrSetupReview_tenantId_kind_state_createdAt_idx" ON "HrSetupReview"("tenantId","kind","state","createdAt");
CREATE INDEX "HrSetupReview_tenantId_subjectKey_idx" ON "HrSetupReview"("tenantId","subjectKey");
CREATE TABLE "HrSetupAudit" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "reviewRef" UUID NOT NULL,
 "version" INTEGER NOT NULL, "action" TEXT NOT NULL, "actorCode" TEXT NOT NULL,
 "actorUserId" INTEGER NOT NULL, "reason" TEXT NOT NULL, "contentHash" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "HrSetupAudit_tenantId_reviewRef_version_key" ON "HrSetupAudit"("tenantId","reviewRef","version");
CREATE TABLE "HrSetupReceipt" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "requestKey" UUID NOT NULL,
 "actorUserId" INTEGER NOT NULL, "digest" TEXT NOT NULL, "result" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "HrSetupReceipt_tenantId_requestKey_key" ON "HrSetupReceipt"("tenantId","requestKey");

-- SETUP_SECURITY: also loaded by the isolated integration-test bootstrap.
ALTER TABLE "HrSetupReview" ADD CONSTRAINT "HrSetupReview_kind_check" CHECK ("kind" IN ('POLICY','EMPLOYEE_SETUP','IDENTITY'));
ALTER TABLE "HrSetupReview" ADD CONSTRAINT "HrSetupReview_state_check" CHECK ("state" IN ('DRAFT','MANAGEMENT','RETURNED','REJECTED','APPROVED','ACTIVATING','ACTIVE'));
ALTER TABLE "HrSetupReview" ADD CONSTRAINT "HrSetupReview_approval_check" CHECK ("state" NOT IN ('APPROVED','ACTIVATING','ACTIVE') OR ("approvedByUserId" IS NOT NULL AND "approvedByUserId" <> "preparedByUserId" AND "approvedHash" IS NOT NULL AND "approvedHash" = "contentHash" AND "approvedAt" IS NOT NULL AND NOT ("editorUserIds" @> jsonb_build_array("approvedByUserId"))));
CREATE UNIQUE INDEX "HrSetupReview_open_subject" ON "HrSetupReview"("tenantId","subjectKey") WHERE "state" NOT IN ('ACTIVE','REJECTED');
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['HrSetupReview','HrSetupAudit','HrSetupReceipt'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY setup_tenant ON %I USING ("tenantId" = public.hr_current_tenant()) WITH CHECK ("tenantId" = public.hr_current_tenant())',tab);
 END LOOP;
END $$;
CREATE FUNCTION hr_setup_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'HR setup audit and command receipts are append-only';
END $$;
CREATE TRIGGER setup_audit_immutable BEFORE UPDATE OR DELETE ON "HrSetupAudit" FOR EACH ROW EXECUTE FUNCTION hr_setup_append_only();
CREATE TRIGGER setup_receipt_immutable BEFORE UPDATE OR DELETE ON "HrSetupReceipt" FOR EACH ROW EXECUTE FUNCTION hr_setup_append_only();
CREATE FUNCTION hr_setup_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'HR setup reviews cannot be deleted'; END IF;
 IF NEW."tenantId" <> OLD."tenantId" OR NEW.kind <> OLD.kind OR NEW."subjectKey" <> OLD."subjectKey" OR NEW."employeeCode" IS DISTINCT FROM OLD."employeeCode" THEN RAISE EXCEPTION 'Review subject is immutable'; END IF;
 IF OLD.state NOT IN ('DRAFT','RETURNED','REJECTED') AND (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.source IS DISTINCT FROM OLD.source OR NEW."contentHash" <> OLD."contentHash" OR NEW."editorUserIds" <> OLD."editorUserIds") THEN RAISE EXCEPTION 'Reviewed content is immutable'; END IF;
 IF OLD.state = 'ACTIVE' THEN RAISE EXCEPTION 'Activated review is immutable'; END IF;
 IF OLD.state = 'ACTIVATING' AND (NEW.state NOT IN ('ACTIVATING','ACTIVE') OR NEW."activationPlan" IS DISTINCT FROM OLD."activationPlan") THEN RAISE EXCEPTION 'Pending identity plan must be reconciled'; END IF;
 IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'Review version must advance exactly once'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER setup_review_guard BEFORE UPDATE OR DELETE ON "HrSetupReview" FOR EACH ROW EXECUTE FUNCTION hr_setup_review_guard();
CREATE FUNCTION hr_setup_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Active policy cannot be deleted'; END IF;
 IF NEW."approvalReviewRef" IS NULL OR current_setting('app.hr_setup_review',true) IS DISTINCT FROM NEW."approvalReviewRef"::text OR NOT EXISTS (
  SELECT 1 FROM "HrSetupReview" r WHERE r.id=NEW."approvalReviewRef" AND r."tenantId"=NEW."tenantId" AND r.kind='POLICY' AND r.state='APPROVED' AND r."approvedHash"=r."contentHash"
 ) THEN RAISE EXCEPTION 'Management-approved company policy review required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER setup_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON "SeparationPolicy" FOR EACH ROW EXECUTE FUNCTION hr_setup_policy_guard();
CREATE FUNCTION hr_setup_identity_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM "HrSetupReview" r WHERE r."tenantId"=NEW.tenant_id AND r.state='ACTIVATING' AND r."reservedUserId"=NEW."userId") THEN RAISE EXCEPTION 'Identity correction pending; employee account link is reserved'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP = 'UPDATE' AND NEW."userId" IS NOT DISTINCT FROM OLD."userId" AND NEW.employee_code IS NOT DISTINCT FROM OLD.employee_code AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.employement_status IS NOT DISTINCT FROM OLD.employement_status THEN RETURN NEW; END IF;
 IF EXISTS (SELECT 1 FROM "HrSetupReview" r WHERE r."tenantId"=OLD.tenant_id AND r.state='ACTIVATING' AND (r."reservedEmployeeId"=OLD.id OR r."reservedUserId"=OLD."userId" OR (TG_OP='UPDATE' AND r."reservedUserId"=NEW."userId")) AND current_setting('app.hr_setup_review',true) IS DISTINCT FROM r.id::text) THEN RAISE EXCEPTION 'Identity correction pending; retry its approved activation first'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER setup_identity_reservation BEFORE INSERT OR UPDATE OR DELETE ON "Employee" FOR EACH ROW EXECUTE FUNCTION hr_setup_identity_reservation();

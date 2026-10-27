-- Employee sourcing preserves candidate-owned consent and immutable attribution.
CREATE UNIQUE INDEX "Employee_recruitment_tenant_id" ON "Employee"(tenant_id,id);
CREATE UNIQUE INDEX "JobRequisition_recruitment_tenant_id" ON "JobRequisition"("tenantId",id);
ALTER TABLE "JobPosting" DROP CONSTRAINT "JobPosting_channel_check";
ALTER TABLE "JobPosting" ADD CONSTRAINT "JobPosting_channel_check" CHECK(channel IN ('CAREER_SITE','INTERNAL','LINKEDIN','INDEED','AGENCY','REFERRAL','OTHER'));
CREATE TABLE "InternalReferral" (
 id UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"candidateId" INTEGER NOT NULL,"requisitionId" INTEGER NOT NULL,"referrerEmployeeId" INTEGER NOT NULL,
 "requestKey" UUID NOT NULL,fingerprint TEXT NOT NULL,"suppliedName" TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'INVITED',
 "bonusEligibility" TEXT NOT NULL DEFAULT 'PENDING',"bonusReason" TEXT,"bonusReviewedById" INTEGER,"bonusReviewedAt" TIMESTAMPTZ(3),
 version INTEGER NOT NULL DEFAULT 0,"expiresAt" TIMESTAMPTZ(3) NOT NULL,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "InternalReferral_tenantId_candidateId_fkey" FOREIGN KEY("tenantId","candidateId") REFERENCES "Candidate"("tenantId",id) ON UPDATE CASCADE ON DELETE CASCADE,
 CONSTRAINT "InternalReferral_tenantId_requisitionId_fkey" FOREIGN KEY("tenantId","requisitionId") REFERENCES "JobRequisition"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "InternalReferral_tenantId_referrerEmployeeId_fkey" FOREIGN KEY("tenantId","referrerEmployeeId") REFERENCES "Employee"(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "InternalReferral_tenantId_bonusReviewedById_fkey" FOREIGN KEY("tenantId","bonusReviewedById") REFERENCES "Employee"(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "InternalReferral_independent_review" CHECK("bonusReviewedById" IS NULL OR "bonusReviewedById"<>"referrerEmployeeId"),
 CONSTRAINT "InternalReferral_state_check" CHECK(state IN ('INVITED','SUBMITTED','EXPIRED')),
 CONSTRAINT "InternalReferral_bonus_check" CHECK("bonusEligibility" IN ('PENDING','ELIGIBLE','INELIGIBLE')),
 CONSTRAINT "InternalReferral_bonus_review_check" CHECK(("bonusEligibility"='PENDING' AND "bonusReviewedAt" IS NULL AND "bonusReviewedById" IS NULL) OR ("bonusEligibility"<>'PENDING' AND state='SUBMITTED' AND "bonusReviewedAt" IS NOT NULL AND "bonusReviewedById" IS NOT NULL AND length(trim("bonusReason"))>0)),
 CONSTRAINT "InternalReferral_version_check" CHECK(version>=0 AND length(fingerprint)=64)
);
CREATE UNIQUE INDEX "InternalReferral_tenantId_id_key" ON "InternalReferral"("tenantId",id);
CREATE UNIQUE INDEX "InternalReferral_tenantId_requestKey_key" ON "InternalReferral"("tenantId","requestKey");
CREATE UNIQUE INDEX "InternalReferral_tenantId_candidateId_requisitionId_key" ON "InternalReferral"("tenantId","candidateId","requisitionId");
CREATE INDEX "InternalReferral_tenantId_referrerEmployeeId_createdAt_idx" ON "InternalReferral"("tenantId","referrerEmployeeId","createdAt");
ALTER TABLE "InternalReferral" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InternalReferral" FORCE ROW LEVEL SECURITY;
CREATE POLICY internal_referral_company ON "InternalReferral" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "Application" ADD COLUMN source TEXT,ADD COLUMN "sourceEmployeeId" INTEGER,ADD COLUMN "internalReferralId" UUID;
ALTER TABLE application_drafts ADD COLUMN source TEXT NOT NULL DEFAULT 'PORTAL',ADD COLUMN "sourceEmployeeId" INTEGER,ADD COLUMN "internalReferralId" UUID;
ALTER TABLE "Application" ADD CONSTRAINT "Application_tenantId_sourceEmployeeId_fkey" FOREIGN KEY("tenantId","sourceEmployeeId") REFERENCES "Employee"(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Application" ADD CONSTRAINT "Application_tenantId_internalReferralId_fkey" FOREIGN KEY("tenantId","internalReferralId") REFERENCES "InternalReferral"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE application_drafts ADD CONSTRAINT "application_drafts_tenantId_sourceEmployeeId_fkey" FOREIGN KEY("tenantId","sourceEmployeeId") REFERENCES "Employee"(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE application_drafts ADD CONSTRAINT "application_drafts_tenantId_internalReferralId_fkey" FOREIGN KEY("tenantId","internalReferralId") REFERENCES "InternalReferral"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE UNIQUE INDEX "Application_internalReferralId_key" ON "Application"("internalReferralId");
CREATE UNIQUE INDEX "Application_tenantId_internalReferralId_key" ON "Application"("tenantId","internalReferralId");
CREATE UNIQUE INDEX "application_drafts_internalReferralId_key" ON application_drafts("internalReferralId");
CREATE UNIQUE INDEX "application_drafts_tenantId_internalReferralId_key" ON application_drafts("tenantId","internalReferralId");
CREATE FUNCTION hr_guard_internal_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate_erased BOOLEAN; req_id INTEGER;
BEGIN
 SELECT "anonymizedAt" IS NOT NULL INTO candidate_erased FROM "Candidate" WHERE id=NEW."candidateId" AND "tenantId"=NEW."tenantId";
 IF candidate_erased AND NEW."sourceEmployeeId" IS NULL AND NEW."internalReferralId" IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.source IN ('INTERNAL','REFERRAL') AND (NEW."candidateId" IS DISTINCT FROM OLD."candidateId" OR COALESCE(to_jsonb(NEW)->>'jobRequisitionId',to_jsonb(NEW)->>'requisitionId') IS DISTINCT FROM COALESCE(to_jsonb(OLD)->>'jobRequisitionId',to_jsonb(OLD)->>'requisitionId')) THEN RAISE EXCEPTION 'HR-5305: source owner is immutable'; END IF;
  IF ROW(NEW.source,NEW."sourceEmployeeId",NEW."internalReferralId") IS DISTINCT FROM ROW(OLD.source,OLD."sourceEmployeeId",OLD."internalReferralId") THEN RAISE EXCEPTION 'HR-5305: application origin is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.source='INTERNAL' THEN
  IF NEW."sourceEmployeeId" IS NULL OR NEW."internalReferralId" IS NOT NULL THEN RAISE EXCEPTION 'HR-5305: internal source requires its employee'; END IF;
  IF NOT EXISTS(SELECT 1 FROM "Employee" e JOIN "Candidate" c ON c."tenantId"=e.tenant_id WHERE e.tenant_id=NEW."tenantId" AND e.id=NEW."sourceEmployeeId" AND c.id=NEW."candidateId" AND lower(trim(COALESCE(NULLIF(trim(e.work_email),''),trim(e.email))))=lower(trim(c.email))) THEN RAISE EXCEPTION 'HR-5305: internal mailbox ownership mismatch'; END IF;
 ELSIF NEW.source='REFERRAL' THEN
  IF NEW."internalReferralId" IS NULL OR NEW."sourceEmployeeId" IS NOT NULL THEN RAISE EXCEPTION 'HR-5305: referral source requires its referral'; END IF;
  IF TG_TABLE_NAME='Application' THEN req_id=NEW."jobRequisitionId"; ELSE req_id=NEW."requisitionId"; END IF;
  IF NOT EXISTS(SELECT 1 FROM "InternalReferral" WHERE id=NEW."internalReferralId" AND "tenantId"=NEW."tenantId" AND "candidateId"=NEW."candidateId" AND "requisitionId"=req_id) THEN RAISE EXCEPTION 'HR-5305: referral identity mismatch'; END IF;
 ELSIF NEW."sourceEmployeeId" IS NOT NULL OR NEW."internalReferralId" IS NOT NULL THEN RAISE EXCEPTION 'HR-5305: unexpected source identity';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER internal_application_source BEFORE INSERT OR UPDATE ON "Application" FOR EACH ROW EXECUTE FUNCTION hr_guard_internal_source();
CREATE TRIGGER internal_draft_source BEFORE INSERT OR UPDATE ON application_drafts FOR EACH ROW EXECUTE FUNCTION hr_guard_internal_source();
CREATE TABLE "RecruitmentSourcingReceipt" (
 id UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"requestKey" UUID NOT NULL,"actorEmployeeId" INTEGER NOT NULL,"candidateId" INTEGER,
 operation TEXT NOT NULL,fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "RecruitmentSourcingReceipt_tenantId_actorEmployeeId_fkey" FOREIGN KEY("tenantId","actorEmployeeId") REFERENCES "Employee"(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "RecruitmentSourcingReceipt_tenantId_candidateId_fkey" FOREIGN KEY("tenantId","candidateId") REFERENCES "Candidate"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "RecruitmentSourcingReceipt_tenantId_requestKey_key" ON "RecruitmentSourcingReceipt"("tenantId","requestKey");
CREATE INDEX "RecruitmentSourcingReceipt_tenantId_candidateId_idx" ON "RecruitmentSourcingReceipt"("tenantId","candidateId");
ALTER TABLE "RecruitmentSourcingReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecruitmentSourcingReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY sourcing_receipt_company ON "RecruitmentSourcingReceipt" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
CREATE FUNCTION erase_candidate_internal_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."anonymizedAt" IS NOT NULL AND OLD."anonymizedAt" IS NULL THEN
  UPDATE "Application" SET "sourceEmployeeId"=NULL,"internalReferralId"=NULL WHERE "tenantId"=NEW."tenantId" AND "candidateId"=NEW.id;
  DELETE FROM application_drafts WHERE "tenantId"=NEW."tenantId" AND "candidateId"=NEW.id;
  DELETE FROM "RecruitmentSourcingReceipt" WHERE "tenantId"=NEW."tenantId" AND "candidateId"=NEW.id;
  DELETE FROM "InternalReferral" WHERE "tenantId"=NEW."tenantId" AND "candidateId"=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_internal_source_erasure AFTER UPDATE OF "anonymizedAt" ON "Candidate" FOR EACH ROW EXECUTE FUNCTION erase_candidate_internal_sources();

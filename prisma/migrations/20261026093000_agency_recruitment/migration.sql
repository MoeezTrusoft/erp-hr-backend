CREATE TABLE "RecruitmentAgency" (
 id UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"userId" INTEGER NOT NULL CHECK("userId">0),
 "displayName" TEXT NOT NULL,"contactEmail" TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "RecruitmentAgency_tenantId_id_key" ON "RecruitmentAgency"("tenantId",id);
CREATE UNIQUE INDEX "RecruitmentAgency_tenantId_userId_key" ON "RecruitmentAgency"("tenantId","userId");
CREATE TABLE "RequisitionAgencyAssignment" (
 id UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"requisitionId" INTEGER NOT NULL,"agencyId" UUID NOT NULL,
 active BOOLEAN NOT NULL DEFAULT true,version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),"updatedById" INTEGER NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "RequisitionAgencyAssignment_tenantId_requisitionId_fkey" FOREIGN KEY("tenantId","requisitionId") REFERENCES "JobRequisition"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "RequisitionAgencyAssignment_tenantId_agencyId_fkey" FOREIGN KEY("tenantId","agencyId") REFERENCES "RecruitmentAgency"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "RequisitionAgencyAssignment_tenantId_requisitionId_agencyId_key" ON "RequisitionAgencyAssignment"("tenantId","requisitionId","agencyId");
CREATE INDEX "RequisitionAgencyAssignment_tenantId_agencyId_active_idx" ON "RequisitionAgencyAssignment"("tenantId","agencyId",active);
CREATE TABLE "AgencySubmission" (
 id UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"agencyId" UUID NOT NULL,"candidateId" INTEGER NOT NULL,"requisitionId" INTEGER NOT NULL,
 "requestKey" UUID NOT NULL,fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),"suppliedName" TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'INVITED' CHECK(state IN ('INVITED','SUBMITTED','ACCEPTED','REJECTED')),
 "decisionReason" TEXT,"reviewedById" INTEGER,"reviewedAt" TIMESTAMPTZ(3),version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AgencySubmission_tenantId_agencyId_fkey" FOREIGN KEY("tenantId","agencyId") REFERENCES "RecruitmentAgency"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "AgencySubmission_tenantId_candidateId_fkey" FOREIGN KEY("tenantId","candidateId") REFERENCES "Candidate"("tenantId",id) ON UPDATE CASCADE ON DELETE CASCADE,
 CONSTRAINT "AgencySubmission_tenantId_requisitionId_fkey" FOREIGN KEY("tenantId","requisitionId") REFERENCES "JobRequisition"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "AgencySubmission_tenantId_reviewedById_fkey" FOREIGN KEY("tenantId","reviewedById") REFERENCES "Employee"(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "AgencySubmission_review_required" CHECK((state IN ('INVITED','SUBMITTED') AND "reviewedAt" IS NULL AND "reviewedById" IS NULL AND "decisionReason" IS NULL) OR (state IN ('ACCEPTED','REJECTED') AND "reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL AND length(trim("decisionReason")) BETWEEN 5 AND 500))
);
CREATE UNIQUE INDEX "AgencySubmission_tenantId_id_key" ON "AgencySubmission"("tenantId",id);
CREATE UNIQUE INDEX "AgencySubmission_tenantId_candidateId_requisitionId_key" ON "AgencySubmission"("tenantId","candidateId","requisitionId");
CREATE INDEX "AgencySubmission_tenantId_agencyId_createdAt_idx" ON "AgencySubmission"("tenantId","agencyId","createdAt");
CREATE TABLE "AgencyCommandReceipt" (
 id UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"agencyId" UUID NOT NULL,"requestKey" UUID NOT NULL,
 fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),"candidateId" INTEGER,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AgencyCommandReceipt_tenantId_agencyId_fkey" FOREIGN KEY("tenantId","agencyId") REFERENCES "RecruitmentAgency"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT "AgencyCommandReceipt_tenantId_candidateId_fkey" FOREIGN KEY("tenantId","candidateId") REFERENCES "Candidate"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "AgencyCommandReceipt_tenantId_requestKey_key" ON "AgencyCommandReceipt"("tenantId","requestKey");
CREATE INDEX "AgencyCommandReceipt_tenantId_candidateId_idx" ON "AgencyCommandReceipt"("tenantId","candidateId");
DO $$ DECLARE table_name TEXT; BEGIN
 FOREACH table_name IN ARRAY ARRAY['RecruitmentAgency','RequisitionAgencyAssignment','AgencySubmission','AgencyCommandReceipt'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY agency_company ON %I USING ("tenantId"=public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'')',table_name);
 END LOOP;
END $$;
ALTER TABLE "Candidate" ADD COLUMN "ownerAgencyId" UUID;
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_tenantId_ownerAgencyId_fkey" FOREIGN KEY("tenantId","ownerAgencyId") REFERENCES "RecruitmentAgency"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Application" ADD COLUMN "ownerAgencyId" UUID,ADD COLUMN "agencySubmissionId" UUID;
ALTER TABLE application_drafts ADD COLUMN "ownerAgencyId" UUID,ADD COLUMN "agencySubmissionId" UUID;
ALTER TABLE "Application" ADD CONSTRAINT "Application_tenantId_ownerAgencyId_fkey" FOREIGN KEY("tenantId","ownerAgencyId") REFERENCES "RecruitmentAgency"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Application" ADD CONSTRAINT "Application_tenantId_agencySubmissionId_fkey" FOREIGN KEY("tenantId","agencySubmissionId") REFERENCES "AgencySubmission"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE application_drafts ADD CONSTRAINT "application_drafts_tenantId_ownerAgencyId_fkey" FOREIGN KEY("tenantId","ownerAgencyId") REFERENCES "RecruitmentAgency"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE application_drafts ADD CONSTRAINT "application_drafts_tenantId_agencySubmissionId_fkey" FOREIGN KEY("tenantId","agencySubmissionId") REFERENCES "AgencySubmission"("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE UNIQUE INDEX "Application_agencySubmissionId_key" ON "Application"("agencySubmissionId");
CREATE UNIQUE INDEX "Application_tenantId_agencySubmissionId_key" ON "Application"("tenantId","agencySubmissionId");
CREATE UNIQUE INDEX "application_drafts_agencySubmissionId_key" ON application_drafts("agencySubmissionId");
CREATE UNIQUE INDEX "application_drafts_tenantId_agencySubmissionId_key" ON application_drafts("tenantId","agencySubmissionId");
CREATE FUNCTION hr_guard_agency_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."ownerAgencyId" IS DISTINCT FROM OLD."ownerAgencyId" AND NOT (NEW."anonymizedAt" IS NOT NULL AND NEW."ownerAgencyId" IS NULL) THEN RAISE EXCEPTION 'HR-5306: agency ownership is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agency_candidate_owner BEFORE UPDATE OF "ownerAgencyId" ON "Candidate" FOR EACH ROW EXECUTE FUNCTION hr_guard_agency_candidate();
CREATE FUNCTION hr_guard_agency_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE erased BOOLEAN; req_id INTEGER; submission "AgencySubmission";
BEGIN
 SELECT "anonymizedAt" IS NOT NULL INTO erased FROM "Candidate" WHERE id=NEW."candidateId" AND "tenantId"=NEW."tenantId";
 IF erased AND NEW."ownerAgencyId" IS NULL AND NEW."agencySubmissionId" IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW."ownerAgencyId",NEW."agencySubmissionId",NEW."candidateId") IS DISTINCT FROM ROW(OLD."ownerAgencyId",OLD."agencySubmissionId",OLD."candidateId") THEN
  IF OLD."ownerAgencyId" IS NOT NULL OR NEW."ownerAgencyId" IS NOT NULL OR OLD."agencySubmissionId" IS NOT NULL OR NEW."agencySubmissionId" IS NOT NULL THEN RAISE EXCEPTION 'HR-5306: agency application origin is immutable'; END IF;
 END IF;
 IF TG_TABLE_NAME='Application' THEN req_id=NEW."jobRequisitionId"; ELSE req_id=NEW."requisitionId"; END IF;
 IF NEW.source='AGENCY' THEN
  SELECT * INTO submission FROM "AgencySubmission" WHERE id=NEW."agencySubmissionId" AND "tenantId"=NEW."tenantId";
  IF submission.id IS NULL OR submission."agencyId" IS DISTINCT FROM NEW."ownerAgencyId" OR submission."candidateId"<>NEW."candidateId" OR submission."requisitionId"<>req_id OR
   NOT EXISTS(SELECT 1 FROM "Candidate" WHERE id=NEW."candidateId" AND "tenantId"=NEW."tenantId" AND "ownerAgencyId"=NEW."ownerAgencyId") THEN RAISE EXCEPTION 'HR-5306: agency source binding mismatch'; END IF;
  IF TG_TABLE_NAME='Application' THEN
   IF NEW.stage IN ('screening','interview','offer','hired') AND submission.state<>'ACCEPTED' THEN RAISE EXCEPTION 'HR-5306: recruiter must accept the agency submission'; END IF;
  END IF;
 ELSIF NEW."ownerAgencyId" IS NOT NULL OR NEW."agencySubmissionId" IS NOT NULL THEN RAISE EXCEPTION 'HR-5306: unexpected agency owner'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agency_application_source BEFORE INSERT OR UPDATE ON "Application" FOR EACH ROW EXECUTE FUNCTION hr_guard_agency_source();
CREATE TRIGGER agency_draft_source BEFORE INSERT OR UPDATE ON application_drafts FOR EACH ROW EXECUTE FUNCTION hr_guard_agency_source();
CREATE FUNCTION hr_erase_agency_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."anonymizedAt" IS NOT NULL AND OLD."anonymizedAt" IS NULL THEN
  UPDATE "Application" SET "ownerAgencyId"=NULL,"agencySubmissionId"=NULL WHERE "tenantId"=NEW."tenantId" AND "candidateId"=NEW.id;
  DELETE FROM application_drafts WHERE "tenantId"=NEW."tenantId" AND "candidateId"=NEW.id;
  DELETE FROM "AgencyCommandReceipt" WHERE "tenantId"=NEW."tenantId" AND "candidateId"=NEW.id;
  DELETE FROM "AgencySubmission" WHERE "tenantId"=NEW."tenantId" AND "candidateId"=NEW.id;
  UPDATE "Candidate" SET "ownerAgencyId"=NULL WHERE id=NEW.id AND "tenantId"=NEW."tenantId";
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_agency_source_erasure AFTER UPDATE OF "anonymizedAt" ON "Candidate" FOR EACH ROW EXECUTE FUNCTION hr_erase_agency_source();

-- Preserve the agency's original ownership and require a real candidate-owned
-- application before an agency receipt can be reviewed.
CREATE FUNCTION hr_guard_agency_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "Candidate" WHERE "tenantId"=NEW."tenantId" AND id=NEW."candidateId" AND "ownerAgencyId"=NEW."agencyId" AND "anonymizedAt" IS NULL) THEN
  RAISE EXCEPTION 'HR-5306: agency candidate ownership mismatch';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'INVITED' OR NEW.version<>0 THEN RAISE EXCEPTION 'HR-5306: submission must begin with an invitation'; END IF;
 ELSE
  IF ROW(NEW.id,NEW."tenantId",NEW."agencyId",NEW."candidateId",NEW."requisitionId",NEW."requestKey",NEW.fingerprint,NEW."suppliedName",NEW."createdAt") IS DISTINCT FROM
     ROW(OLD.id,OLD."tenantId",OLD."agencyId",OLD."candidateId",OLD."requisitionId",OLD."requestKey",OLD.fingerprint,OLD."suppliedName",OLD."createdAt") THEN RAISE EXCEPTION 'HR-5306: agency submission ownership is immutable'; END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'HR-5306: submission version must advance'; END IF;
  IF OLD.state IN ('ACCEPTED','REJECTED') OR NOT (OLD.state=NEW.state OR (OLD.state='INVITED' AND NEW.state='SUBMITTED') OR (OLD.state='SUBMITTED' AND NEW.state IN ('ACCEPTED','REJECTED'))) THEN RAISE EXCEPTION 'HR-5306: invalid agency submission transition'; END IF;
  IF NEW.state<>'INVITED' THEN
   IF NOT EXISTS(SELECT 1 FROM "Application" a JOIN "Candidate" c ON c.id=a."candidateId" AND c."tenantId"=a."tenantId" WHERE a."tenantId"=NEW."tenantId" AND a."agencySubmissionId"=NEW.id AND a."ownerAgencyId"=NEW."agencyId" AND c."consentStatus"='GRANTED' AND c.status='active' AND c."anonymizedAt" IS NULL) THEN RAISE EXCEPTION 'HR-5306: a consented candidate application is required'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agency_submission_guard BEFORE INSERT OR UPDATE ON "AgencySubmission" FOR EACH ROW EXECUTE FUNCTION hr_guard_agency_submission();
CREATE FUNCTION hr_guard_agency_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW."tenantId",NEW."userId",NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD."tenantId",OLD."userId",OLD."createdAt") THEN RAISE EXCEPTION 'HR-5306: agency account identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agency_account_identity BEFORE UPDATE ON "RecruitmentAgency" FOR EACH ROW EXECUTE FUNCTION hr_guard_agency_account();

ALTER TABLE "RequisitionAgencyAssignment" ADD CONSTRAINT "RequisitionAgencyAssignment_tenantId_updatedById_fkey" FOREIGN KEY("tenantId","updatedById") REFERENCES "Employee"(tenant_id,id) ON UPDATE CASCADE ON DELETE RESTRICT;

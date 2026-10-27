CREATE TABLE candidate_document_uploads (
 id TEXT PRIMARY KEY, "tenantId" UUID NOT NULL, "candidateId" INTEGER NOT NULL REFERENCES "Candidate"(id) ON DELETE CASCADE,
 "draftId" INTEGER REFERENCES application_drafts(id) ON DELETE SET NULL, purpose TEXT NOT NULL DEFAULT 'RESUME',
 "contentHash" TEXT NOT NULL, "mediaId" INTEGER, status TEXT NOT NULL DEFAULT 'PENDING',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
 "updatedAt" TIMESTAMP(3) NOT NULL, "lastError" TEXT,
 CONSTRAINT candidate_document_upload_status CHECK (status IN ('PENDING','READY','DELETE_PENDING','DELETED','FAILED')),
 CONSTRAINT candidate_document_upload_purpose CHECK (purpose IN ('RESUME','PORTFOLIO','APPLICATION')),
 CONSTRAINT candidate_document_upload_hash CHECK ("contentHash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "candidate_document_uploads_tenantId_candidateId_contentHash_key" ON candidate_document_uploads("tenantId","candidateId","contentHash");
CREATE INDEX "candidate_document_uploads_tenantId_status_idx" ON candidate_document_uploads("tenantId",status);
ALTER TABLE candidate_document_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_document_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON candidate_document_uploads USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
GRANT SELECT, INSERT, UPDATE, DELETE ON candidate_document_uploads TO hr_app;
CREATE FUNCTION hr_candidate_upload_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "Candidate" WHERE id=NEW."candidateId" AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5804: invalid document owner'; END IF;
 IF NEW."draftId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM application_drafts WHERE id=NEW."draftId" AND "candidateId"=NEW."candidateId" AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5804: invalid draft owner'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_candidate_upload_owner BEFORE INSERT OR UPDATE ON candidate_document_uploads FOR EACH ROW EXECUTE FUNCTION hr_candidate_upload_owner();

ALTER TABLE resume_parse_attempts ADD COLUMN "leaseToken" TEXT, ADD COLUMN "leaseUntil" TIMESTAMP(3);
CREATE TABLE candidate_resume_parse_jobs (
 id SERIAL PRIMARY KEY,"tenantId" UUID NOT NULL,"candidateId" INTEGER NOT NULL REFERENCES "Candidate"(id) ON DELETE CASCADE,"mediaId" INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING',attempts INTEGER NOT NULL DEFAULT 0,"dueAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
 "leaseToken" TEXT,"leaseUntil" TIMESTAMP(3),"lastError" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),"updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE("tenantId","candidateId","mediaId"),CHECK(status IN ('PENDING','RUNNING','RETRY','COMPLETED','FAILED','CANCELLED')),CHECK(attempts>=0 AND attempts<=3),CHECK("mediaId">0)
);
CREATE INDEX candidate_resume_parse_jobs_due_idx ON candidate_resume_parse_jobs(status,"dueAt");
ALTER TABLE candidate_resume_parse_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_resume_parse_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON candidate_resume_parse_jobs USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
GRANT SELECT,INSERT,UPDATE,DELETE ON candidate_resume_parse_jobs TO hr_app;
GRANT USAGE,SELECT ON SEQUENCE candidate_resume_parse_jobs_id_seq TO hr_app;
CREATE FUNCTION hr_resume_parse_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "Candidate" WHERE id=NEW."candidateId" AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5901: invalid resume owner'; END IF;
 IF TG_OP='UPDATE' AND (NEW."tenantId",NEW."candidateId",NEW."mediaId") IS DISTINCT FROM (OLD."tenantId",OLD."candidateId",OLD."mediaId") THEN RAISE EXCEPTION 'HR-5901: parse job identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_resume_parse_job_guard BEFORE INSERT OR UPDATE ON candidate_resume_parse_jobs FOR EACH ROW EXECUTE FUNCTION hr_resume_parse_job_guard();

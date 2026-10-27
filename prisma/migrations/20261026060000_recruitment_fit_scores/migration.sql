ALTER TABLE application_questions ADD COLUMN knockout BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "minimumScore" INTEGER;
ALTER TABLE application_questions ADD CONSTRAINT application_question_knockout CHECK (NOT knockout OR (required AND weights IS NOT NULL AND "minimumScore" IS NOT NULL AND "minimumScore">=0 AND "minimumScore"<="maxScore"));
CREATE TABLE application_scores (
 id SERIAL PRIMARY KEY,"tenantId" UUID NOT NULL,"applicationId" INTEGER NOT NULL REFERENCES "Application"(id) ON DELETE CASCADE,
 "modelVersion" TEXT NOT NULL,"inputHash" TEXT NOT NULL,"scorePct" DOUBLE PRECISION,"knockoutFailed" BOOLEAN NOT NULL DEFAULT false,
 explanation JSONB NOT NULL,"rankSnapshot" INTEGER,"scoredAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
 CONSTRAINT application_score_bounded CHECK ("scorePct" IS NULL OR ("scorePct">=0 AND "scorePct"<=100))
);
CREATE INDEX "application_scores_tenantId_applicationId_modelVersion_inputHash_idx" ON application_scores("tenantId","applicationId","modelVersion","inputHash");
CREATE INDEX "application_scores_tenantId_applicationId_scoredAt_idx" ON application_scores("tenantId","applicationId","scoredAt");
ALTER TABLE application_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_scores FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON application_scores USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
GRANT SELECT, INSERT, UPDATE, DELETE ON application_scores TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE application_scores_id_seq TO hr_app;
CREATE FUNCTION hr_application_score_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "Application" WHERE id=NEW."applicationId" AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5302: invalid score owner'; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'rankSnapshot') IS DISTINCT FROM (to_jsonb(OLD)-'rankSnapshot') THEN RAISE EXCEPTION 'HR-5302: score evidence is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_application_score_owner BEFORE INSERT OR UPDATE ON application_scores FOR EACH ROW EXECUTE FUNCTION hr_application_score_owner();

CREATE POLICY platform_catalog_read ON skills FOR SELECT USING ("tenantId" IS NULL);
CREATE POLICY platform_catalog_read ON skill_aliases FOR SELECT USING ("tenantId" IS NULL);

ALTER TABLE skill_aliases FORCE ROW LEVEL SECURITY;

ALTER TABLE skills DROP CONSTRAINT IF EXISTS "skills_tenantId_tenant_not_null_staged";
CREATE POLICY platform_catalog_system ON skill_aliases USING (current_setting('app.tenant_bypass',true)='on') WITH CHECK (current_setting('app.tenant_bypass',true)='on');
CREATE FUNCTION hr_skill_alias_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.scope='PLATFORM') IS DISTINCT FROM (NEW."tenantId" IS NULL) THEN RAISE EXCEPTION 'HR-5904: alias scope does not match its owner'; END IF;
 IF NOT EXISTS(SELECT 1 FROM skills WHERE id=NEW."skillId" AND ("tenantId" IS NULL OR "tenantId"=NEW."tenantId")) THEN RAISE EXCEPTION 'HR-5904: alias must reference an accessible skill'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_skill_alias_owner BEFORE INSERT OR UPDATE ON skill_aliases FOR EACH ROW EXECUTE FUNCTION hr_skill_alias_owner();

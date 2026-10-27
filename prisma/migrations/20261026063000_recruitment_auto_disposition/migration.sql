CREATE TABLE application_auto_dispositions (
 id SERIAL PRIMARY KEY, "tenantId" UUID NOT NULL, "applicationId" INTEGER NOT NULL UNIQUE REFERENCES "Application"(id) ON DELETE CASCADE,
 "scoreId" INTEGER NOT NULL REFERENCES application_scores(id) ON DELETE CASCADE, "policyVersion" INTEGER NOT NULL,
 "rejectionVersion" INTEGER NOT NULL, "previousStage" TEXT NOT NULL CHECK ("previousStage"='applied'),
 "noticeDueAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
 "reversedAt" TIMESTAMP(3), "reversedById" INTEGER REFERENCES "Employee"(id), "reversalReason" TEXT,
 CHECK (("reversedAt" IS NULL AND "reversedById" IS NULL AND "reversalReason" IS NULL) OR ("reversedAt" IS NOT NULL AND "reversedById" IS NOT NULL AND length("reversalReason")>=10 AND "reversedAt"<"noticeDueAt"))
);
CREATE INDEX "application_auto_dispositions_tenantId_noticeDueAt_idx" ON application_auto_dispositions("tenantId","noticeDueAt");
ALTER TABLE application_auto_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_auto_dispositions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON application_auto_dispositions USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
GRANT SELECT, INSERT, UPDATE, DELETE ON application_auto_dispositions TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE application_auto_dispositions_id_seq TO hr_app;
CREATE FUNCTION hr_auto_disposition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM application_scores s JOIN "Application" a ON a.id=s."applicationId" WHERE s.id=NEW."scoreId" AND a.id=NEW."applicationId" AND s."tenantId"=NEW."tenantId" AND a."tenantId"=NEW."tenantId" AND s."knockoutFailed") THEN RAISE EXCEPTION 'HR-5303: automatic disposition requires owned failed knockout evidence'; END IF;
 IF NOT EXISTS (SELECT 1 FROM recruitment_policy_versions p WHERE p."tenantId"=NEW."tenantId" AND p.version=NEW."policyVersion" AND p.policy->>'autoRejectKnockouts'='true') THEN RAISE EXCEPTION 'HR-5303: automatic disposition requires approved policy'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['reversedAt','reversedById','reversalReason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['reversedAt','reversedById','reversalReason']) OR OLD."reversedAt" IS NOT NULL) THEN RAISE EXCEPTION 'HR-5303: automatic disposition evidence is immutable'; END IF;
 IF NEW."reversedById" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Employee" WHERE id=NEW."reversedById" AND tenant_id=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5303: invalid reversing employee'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_auto_disposition_guard BEFORE INSERT OR UPDATE ON application_auto_dispositions FOR EACH ROW EXECUTE FUNCTION hr_auto_disposition_guard();

ALTER TABLE outbox_events ADD COLUMN "communicationProcessedAt" TIMESTAMP(3), ADD COLUMN "communicationCursor" INTEGER NOT NULL DEFAULT 0;
-- Existing events predate the delivery feature. Never email historical changes on rollout.
UPDATE outbox_events SET "communicationProcessedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
CREATE INDEX outbox_candidate_communications_idx ON outbox_events("createdAt") WHERE "communicationProcessedAt" IS NULL AND "eventName" LIKE 'hr.recruitment.%';
CREATE TABLE recruitment_settings ("tenantId" UUID PRIMARY KEY,version INTEGER NOT NULL DEFAULT 1,policy JSONB NOT NULL,"updatedById" INTEGER NOT NULL REFERENCES "Employee"(id),"updatedAt" TIMESTAMP(3) NOT NULL);
CREATE TABLE recruitment_policy_versions (id SERIAL PRIMARY KEY,"tenantId" UUID NOT NULL,version INTEGER NOT NULL,policy JSONB NOT NULL,reason TEXT NOT NULL,"changedById" INTEGER NOT NULL REFERENCES "Employee"(id),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),UNIQUE("tenantId",version));
CREATE TABLE candidate_communications (
 id TEXT PRIMARY KEY,"tenantId" UUID NOT NULL,"candidateId" INTEGER NOT NULL REFERENCES "Candidate"(id),"applicationId" INTEGER REFERENCES "Application"(id),
 "templateKey" TEXT NOT NULL,"templateVersion" INTEGER NOT NULL DEFAULT 1,channel TEXT NOT NULL DEFAULT 'EMAIL',purpose TEXT NOT NULL DEFAULT 'PROCESSING',
 "dedupeKey" TEXT NOT NULL,"sourceEventId" TEXT,context JSONB NOT NULL,"encryptedPayload" TEXT,status TEXT NOT NULL DEFAULT 'PENDING',
 "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),"expiresAt" TIMESTAMP(3),attempts INTEGER NOT NULL DEFAULT 0,
 "leaseToken" TEXT,"leaseUntil" TIMESTAMP(3),"providerRef" TEXT,"lastError" TEXT,"sentAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),"updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE("tenantId","dedupeKey"),
 CHECK (channel IN ('EMAIL','SMS')),CHECK(purpose IN ('PROCESSING','TALENT_POOL','MARKETING')),
 CHECK(status IN ('PENDING','CLAIMED','SENT','FAILED','SUPPRESSED','CANCELLED')),
 CHECK("encryptedPayload" IS NULL OR "encryptedPayload" LIKE 'c4.v1:%')
);
CREATE INDEX candidate_communications_tenant_candidate_idx ON candidate_communications("tenantId","candidateId","createdAt");
CREATE INDEX candidate_communications_due_idx ON candidate_communications(status,"scheduledAt");
DO $$ DECLARE tab TEXT; BEGIN FOREACH tab IN ARRAY ARRAY['recruitment_settings','recruitment_policy_versions','candidate_communications'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'')',tab);
 EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hr_app',tab);
END LOOP; END $$;
GRANT USAGE,SELECT ON SEQUENCE recruitment_policy_versions_id_seq TO hr_app;
CREATE FUNCTION hr_communication_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "Candidate" WHERE id=NEW."candidateId" AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5805: invalid communication owner'; END IF;
 IF NEW."applicationId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Application" WHERE id=NEW."applicationId" AND "candidateId"=NEW."candidateId" AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5805: invalid application owner'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER hr_communication_owner BEFORE INSERT OR UPDATE ON candidate_communications FOR EACH ROW EXECUTE FUNCTION hr_communication_owner();
CREATE FUNCTION hr_recruitment_policy_owner() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE emp INTEGER; BEGIN
 emp=CASE WHEN TG_TABLE_NAME='recruitment_settings' THEN (to_jsonb(NEW)->>'updatedById')::integer ELSE (to_jsonb(NEW)->>'changedById')::integer END;
 IF NOT EXISTS(SELECT 1 FROM "Employee" WHERE id=emp AND tenant_id=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5102: invalid policy actor'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER hr_recruitment_settings_owner BEFORE INSERT OR UPDATE ON recruitment_settings FOR EACH ROW EXECUTE FUNCTION hr_recruitment_policy_owner();
CREATE TRIGGER hr_recruitment_policy_owner BEFORE INSERT ON recruitment_policy_versions FOR EACH ROW EXECUTE FUNCTION hr_recruitment_policy_owner();
CREATE FUNCTION hr_recruitment_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'HR-5102: policy versions are immutable'; END $$;
CREATE TRIGGER hr_recruitment_policy_immutable BEFORE UPDATE OR DELETE ON recruitment_policy_versions FOR EACH ROW EXECUTE FUNCTION hr_recruitment_policy_immutable();

CREATE TABLE "CandidateTestSessionSection" (
 "tenantId" uuid NOT NULL,
 "sessionId" integer NOT NULL,
 "sectionIndex" integer NOT NULL CHECK ("sectionIndex">=0),
 "sectionKey" text NOT NULL,
 "startedAt" timestamp(3) NOT NULL,
 "deadlineAt" timestamp(3) NOT NULL,
 "closedAt" timestamp(3),
 PRIMARY KEY ("tenantId","sessionId","sectionIndex"),
 CONSTRAINT "CandidateTestSessionSection_session_fk" FOREIGN KEY ("tenantId","sessionId") REFERENCES "CandidateTestSession"("tenantId",id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CandidateTestSessionSection_clock_check" CHECK ("deadlineAt">="startedAt" AND ("closedAt" IS NULL OR "closedAt">="startedAt"))
);
CREATE UNIQUE INDEX "CandidateTestSessionSection_active" ON "CandidateTestSessionSection" ("tenantId","sessionId") WHERE "closedAt" IS NULL;
ALTER TABLE "CandidateTestSessionSection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestSessionSection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestSessionSection_tenant_policy" ON "CandidateTestSessionSection"
 USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on')
 WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
-- Keep historical clocks immutable; neither an API retry nor a manual write may reopen them.
CREATE FUNCTION hr_candidate_section_clock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."closedAt" IS NOT NULL OR ROW(OLD."tenantId",OLD."sessionId",OLD."sectionIndex",OLD."sectionKey",OLD."startedAt") IS DISTINCT FROM ROW(NEW."tenantId",NEW."sessionId",NEW."sectionIndex",NEW."sectionKey",NEW."startedAt") THEN
  RAISE EXCEPTION 'HR-6008: closed section and clock identity are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_section_clock_guard BEFORE UPDATE ON "CandidateTestSessionSection" FOR EACH ROW EXECUTE FUNCTION hr_candidate_section_clock_guard();
CREATE OR REPLACE FUNCTION hr_candidate_test_response_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "CandidateTestSession"; section_key text;
BEGIN
 SELECT * INTO s FROM "CandidateTestSession" WHERE id=NEW."sessionId" AND "tenantId"=NEW."tenantId" FOR UPDATE;
 IF s.id IS NULL OR s.status<>'IN_PROGRESS' OR s."deadlineAt"<=(clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'HR-6009: session is not accepting answers'; END IF;
 SELECT i->>'sectionKey' INTO section_key FROM jsonb_array_elements(s."itemOrder") i WHERE (i->>'itemId')::integer=NEW."itemId" AND (i->>'itemVersion')::integer=NEW."itemVersion";
 IF section_key IS NULL THEN RAISE EXCEPTION 'HR-6009: item was not assigned to this session'; END IF;
 IF EXISTS (SELECT 1 FROM "CandidateTestSessionSection" WHERE "tenantId"=s."tenantId" AND "sessionId"=s.id)
 AND NOT EXISTS (SELECT 1 FROM "CandidateTestSessionSection" WHERE "tenantId"=s."tenantId" AND "sessionId"=s.id AND "sectionKey"=section_key AND "closedAt" IS NULL AND "deadlineAt">(clock_timestamp() AT TIME ZONE 'UTC')) THEN
  RAISE EXCEPTION 'HR-6009: section is not accepting answers';
 END IF;
 RETURN NEW;
END $$;

CREATE UNIQUE INDEX onboarding_session_tenant_identity ON onboarding_sessions("tenantId",id);
CREATE TABLE "OnboardingSessionCalendar" (
 "sessionId" INTEGER PRIMARY KEY,"tenantId" UUID NOT NULL,"taskId" INTEGER UNIQUE,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),state TEXT NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','SCHEDULED','CANCELLED','COMPLETED')),
 "scheduledAt" TIMESTAMPTZ(3),"durationMinutes" INTEGER,"timeZone" TEXT,"participantIds" INTEGER[] NOT NULL DEFAULT '{}',"participantUserIds" TEXT[] NOT NULL DEFAULT '{}',
 "actorId" INTEGER,"reasonCipher" TEXT,"sourceHash" TEXT,
 "syncState" TEXT NOT NULL DEFAULT 'IDLE' CHECK("syncState" IN ('IDLE','PENDING','RUNNING','FAILED','SYNCED')),
 "calendarEventId" TEXT,"syncedAt" TIMESTAMPTZ(3),"dueAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "leaseToken" UUID,"leaseUntil" TIMESTAMPTZ(3),attempts INTEGER NOT NULL DEFAULT 0,"lastError" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT onboarding_calendar_session FOREIGN KEY("tenantId","sessionId") REFERENCES onboarding_sessions("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT onboarding_calendar_task FOREIGN KEY("tenantId","taskId") REFERENCES onboarding_tasks("tenantId",id) ON UPDATE CASCADE ON DELETE RESTRICT,
 CONSTRAINT onboarding_calendar_timing CHECK(state IN ('DRAFT','CANCELLED') OR ("scheduledAt" IS NOT NULL AND "durationMinutes" BETWEEN 5 AND 480 AND "timeZone" IS NOT NULL AND cardinality("participantIds")=2 AND version>0))
);
CREATE UNIQUE INDEX onboarding_calendar_company_session ON "OnboardingSessionCalendar"("tenantId","sessionId");
CREATE UNIQUE INDEX onboarding_calendar_company_task ON "OnboardingSessionCalendar"("tenantId","taskId");
CREATE INDEX onboarding_calendar_work ON "OnboardingSessionCalendar"("syncState","dueAt");
CREATE INDEX onboarding_calendar_busy ON "OnboardingSessionCalendar"("tenantId",state,"scheduledAt");
ALTER TABLE "OnboardingSessionCalendar" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingSessionCalendar" FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_calendar_company ON "OnboardingSessionCalendar" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
CREATE FUNCTION onboarding_calendar_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."taskId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM onboarding_tasks t JOIN onboarding_sessions s ON s."tenantId"=t."tenantId" AND s."checklistId"=t."checklistId" WHERE t.id=NEW."taskId" AND s.id=NEW."sessionId" AND s."tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'Session task must belong to the same company checklist'; END IF;
 IF TG_OP='UPDATE' AND (NEW."tenantId",NEW."sessionId",NEW."taskId") IS DISTINCT FROM (OLD."tenantId",OLD."sessionId",OLD."taskId") THEN RAISE EXCEPTION 'Onboarding calendar identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER onboarding_calendar_identity BEFORE INSERT OR UPDATE ON "OnboardingSessionCalendar" FOR EACH ROW EXECUTE FUNCTION onboarding_calendar_identity_guard();

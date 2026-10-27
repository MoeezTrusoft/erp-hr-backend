ALTER TABLE interview_calendar_jobs ADD "legacyEventId" text, ADD "legacyProvider" text;
CREATE OR REPLACE FUNCTION hr_queue_interview_calendar(t uuid, i integer, a text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e text; p text;
BEGIN
 IF t IS NULL THEN RETURN; END IF;
 IF a='UPSERT' AND NOT EXISTS (
  SELECT 1 FROM interviews iv JOIN "Application" app ON app.id=iv."applicationId" AND app."tenantId"=iv."tenantId"
  JOIN "Candidate" c ON c.id=app."candidateId" AND c."tenantId"=app."tenantId"
  WHERE iv.id=i AND iv."tenantId"=t AND c."consentStatus"='GRANTED' AND c."anonymizedAt" IS NULL AND c.status='active'
  AND (iv.status<>'SCHEDULED' OR app.stage NOT IN ('withdrawn','rejected','hired'))
 ) THEN a='CANCEL'; END IF;
 SELECT "calendarEventId","calendarProvider" INTO e,p FROM interviews WHERE id=i AND "tenantId"=t;
 INSERT INTO interview_calendar_jobs ("tenantId","interviewId",action,"legacyEventId","legacyProvider") VALUES(t,i,a,e,p)
 ON CONFLICT ("tenantId","interviewId") DO UPDATE SET revision=interview_calendar_jobs.revision+1,
 action=EXCLUDED.action,state='PENDING',payload=NULL,attempts=0,"dueAt"=now(),
 "legacyEventId"=COALESCE(interview_calendar_jobs."legacyEventId",EXCLUDED."legacyEventId"),
 "legacyProvider"=COALESCE(interview_calendar_jobs."legacyProvider",EXCLUDED."legacyProvider"),
 "leaseToken"=NULL,"leaseUntil"=NULL,"lastError"=NULL,"updatedAt"=now();
 UPDATE interviews SET "calendarSyncStatus"='PENDING' WHERE id=i AND "tenantId"=t;
END $$;
CREATE OR REPLACE FUNCTION hr_interview_calendar_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM hr_queue_interview_calendar(OLD."tenantId",OLD.id,'CANCEL');
  UPDATE interview_calendar_jobs SET "legacyEventId"=COALESCE("legacyEventId",OLD."calendarEventId"),"legacyProvider"=COALESCE("legacyProvider",OLD."calendarProvider") WHERE "tenantId"=OLD."tenantId" AND "interviewId"=OLD.id;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW."tenantId",NEW."applicationId",NEW."scheduledAt",NEW."durationMinutes",NEW.status,NEW."interviewType",NEW.location)
    IS NOT DISTINCT FROM (OLD."tenantId",OLD."applicationId",OLD."scheduledAt",OLD."durationMinutes",OLD.status,OLD."interviewType",OLD.location) THEN RETURN NEW; END IF;
  IF OLD."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
   PERFORM hr_queue_interview_calendar(OLD."tenantId",OLD.id,'CANCEL');
  END IF;
 END IF;
 PERFORM hr_queue_interview_calendar(NEW."tenantId",NEW.id,CASE WHEN NEW.status='CANCELLED' THEN 'CANCEL' ELSE 'UPSERT' END);
 RETURN NEW;
END $$;
SELECT set_config('app.tenant_bypass','on',true);
UPDATE interview_calendar_jobs j SET "legacyEventId"=i."calendarEventId","legacyProvider"=i."calendarProvider"
 FROM interviews i WHERE i."tenantId"=j."tenantId" AND i.id=j."interviewId" AND i."calendarEventId" IS NOT NULL;

-- Reclassify already-withdrawn legacy sources before the flag can be enabled.
SELECT hr_queue_interview_calendar(j."tenantId",j."interviewId",'UPSERT') FROM interview_calendar_jobs j
 JOIN interviews iv ON iv.id=j."interviewId" AND iv."tenantId"=j."tenantId"
 JOIN "Application" app ON app.id=iv."applicationId" AND app."tenantId"=iv."tenantId"
 JOIN "Candidate" c ON c.id=app."candidateId" AND c."tenantId"=app."tenantId"
 WHERE j.action='UPSERT' AND (c."consentStatus"<>'GRANTED' OR c."anonymizedAt" IS NOT NULL OR c.status<>'active' OR (iv.status='SCHEDULED' AND app.stage IN ('withdrawn','rejected','hired')));

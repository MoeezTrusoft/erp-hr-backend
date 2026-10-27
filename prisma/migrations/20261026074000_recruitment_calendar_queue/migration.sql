-- Retain source identifiers after deletion to retry cancellation; no contact data.
CREATE TABLE interview_calendar_jobs (
 "tenantId" uuid NOT NULL, "interviewId" integer NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 action text NOT NULL CHECK (action IN ('UPSERT','CANCEL')),
 state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','SYNCED','FAILED')),
 payload jsonb, attempts integer NOT NULL DEFAULT 0,
 "dueAt" timestamptz NOT NULL DEFAULT now(), "leaseToken" uuid, "leaseUntil" timestamptz,
 "lastError" text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY ("tenantId", "interviewId")
);
CREATE INDEX interview_calendar_jobs_due ON interview_calendar_jobs (state, "dueAt", "leaseUntil");
ALTER TABLE interview_calendar_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_calendar_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON interview_calendar_jobs
 USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on')
 WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');

CREATE FUNCTION hr_queue_interview_calendar(t uuid, i integer, a text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF t IS NULL THEN RETURN; END IF;
 INSERT INTO interview_calendar_jobs ("tenantId","interviewId",action) VALUES(t,i,a)
 ON CONFLICT ("tenantId","interviewId") DO UPDATE SET revision=interview_calendar_jobs.revision+1,
 action=EXCLUDED.action,state='PENDING',payload=NULL,attempts=0,"dueAt"=now(),
 "leaseToken"=NULL,"leaseUntil"=NULL,"lastError"=NULL,"updatedAt"=now();
 UPDATE interviews SET "calendarSyncStatus"='PENDING' WHERE id=i AND "tenantId"=t;
END $$;
CREATE FUNCTION hr_interview_calendar_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM hr_queue_interview_calendar(OLD."tenantId",OLD.id,'CANCEL'); RETURN OLD;
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
CREATE TRIGGER hr_interview_calendar_changed AFTER INSERT OR DELETE OR UPDATE OF "tenantId","applicationId","scheduledAt","durationMinutes",status,"interviewType",location ON interviews
 FOR EACH ROW EXECUTE FUNCTION hr_interview_calendar_changed();
CREATE FUNCTION hr_interview_panel_calendar_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
 FOR r IN SELECT id,"tenantId",status FROM interviews WHERE id IN
  (CASE WHEN TG_OP<>'DELETE' THEN NEW."interviewId" END,CASE WHEN TG_OP<>'INSERT' THEN OLD."interviewId" END)
 LOOP
  PERFORM hr_queue_interview_calendar(r."tenantId",r.id,CASE WHEN r.status='CANCELLED' THEN 'CANCEL' ELSE 'UPSERT' END);
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER hr_interview_panel_calendar_changed AFTER INSERT OR DELETE OR UPDATE OF "interviewId","employeeId",status ON interview_interviewers
 FOR EACH ROW EXECUTE FUNCTION hr_interview_panel_calendar_changed();
CREATE FUNCTION hr_candidate_calendar_privacy_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
 IF (NEW."consentStatus",NEW."anonymizedAt",NEW.status) IS NOT DISTINCT FROM (OLD."consentStatus",OLD."anonymizedAt",OLD.status) THEN RETURN NEW; END IF;
 FOR r IN SELECT i.id,i.status FROM interviews i JOIN "Application" a ON a.id=i."applicationId" AND a."tenantId"=i."tenantId"
 WHERE a."candidateId"=NEW.id AND i."tenantId"=NEW."tenantId"
 LOOP
  PERFORM hr_queue_interview_calendar(NEW."tenantId",r.id,CASE WHEN NEW."consentStatus"<>'GRANTED' OR NEW."anonymizedAt" IS NOT NULL OR NEW.status<>'active' OR r.status='CANCELLED' THEN 'CANCEL' ELSE 'UPSERT' END);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_candidate_calendar_privacy_changed AFTER UPDATE OF "consentStatus","anonymizedAt",status ON "Candidate"
 FOR EACH ROW EXECUTE FUNCTION hr_candidate_calendar_privacy_changed();
CREATE FUNCTION hr_employee_calendar_identity_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
 IF (NEW."userId",NEW.tenant_id) IS NOT DISTINCT FROM (OLD."userId",OLD.tenant_id) THEN RETURN NEW; END IF;
 FOR r IN SELECT i.id,i."tenantId",i.status FROM interviews i JOIN interview_interviewers p ON p."interviewId"=i.id AND p."tenantId"=i."tenantId" WHERE p."employeeId"=NEW.id
 LOOP
  PERFORM hr_queue_interview_calendar(r."tenantId",r.id,CASE WHEN r.status='CANCELLED' THEN 'CANCEL' ELSE 'UPSERT' END);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_employee_calendar_identity_changed AFTER UPDATE OF "userId",tenant_id ON "Employee"
 FOR EACH ROW EXECUTE FUNCTION hr_employee_calendar_identity_changed();
SELECT set_config('app.tenant_bypass','on',true);
INSERT INTO interview_calendar_jobs ("tenantId","interviewId",action)
 SELECT "tenantId",id,CASE WHEN status='CANCELLED' THEN 'CANCEL' ELSE 'UPSERT' END FROM interviews WHERE "tenantId" IS NOT NULL AND (status='SCHEDULED' OR "calendarEventId" IS NOT NULL);
UPDATE interviews SET "calendarSyncStatus"='PENDING' WHERE "tenantId" IS NOT NULL AND (status='SCHEDULED' OR "calendarEventId" IS NOT NULL);

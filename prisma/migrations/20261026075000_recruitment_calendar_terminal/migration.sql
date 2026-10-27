CREATE FUNCTION hr_application_calendar_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
 IF NEW.stage IS NOT DISTINCT FROM OLD.stage OR NEW.stage NOT IN ('withdrawn','rejected','hired') THEN RETURN NEW; END IF;
 FOR r IN SELECT id FROM interviews WHERE "applicationId"=NEW.id AND "tenantId"=NEW."tenantId" AND status='SCHEDULED'
 LOOP
  PERFORM hr_queue_interview_calendar(NEW."tenantId",r.id,'CANCEL');
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_application_calendar_terminal AFTER UPDATE OF stage ON "Application" FOR EACH ROW EXECUTE FUNCTION hr_application_calendar_terminal();

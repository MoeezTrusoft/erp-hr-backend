-- Additive controls for legacy development closure and frozen evidence links.
CREATE FUNCTION assessment_development_closure_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status='COMPLETED' AND OLD.status IS DISTINCT FROM NEW.status AND EXISTS(SELECT 1 FROM "AssessmentIntegration" WHERE "tenantId"=NEW."tenantId" AND kind='DEVELOPMENT' AND "targetRef"=NEW.id::text) AND NOT EXISTS(SELECT 1 FROM "AssessmentRevision" r WHERE r.id::text=current_setting('app.assessment_development_closure',true) AND r."tenantId"=NEW."tenantId" AND r.state='PUBLISHED') THEN RAISE EXCEPTION 'Task-assessment development closes only through new published evidence'; END IF; RETURN NEW; END $$;
CREATE TRIGGER assessment_development_closure_guard BEFORE UPDATE ON development_plan_items FOR EACH ROW EXECUTE FUNCTION assessment_development_closure_guard();
CREATE FUNCTION assessment_link_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a RECORD; BEGIN
 SELECT * INTO a FROM "AssessmentAssignment" WHERE id=OLD."assessmentRef" AND "tenantId"=OLD."tenantId";
 IF a.state NOT IN ('ASSIGNED','IN_PROGRESS','RETURNED') OR a."revisionNo"<>OLD."revisionNo" THEN RAISE EXCEPTION 'Submitted evidence links are frozen'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
CREATE TRIGGER assessment_link_frozen BEFORE UPDATE OR DELETE ON "AssessmentEvidenceLink" FOR EACH ROW EXECUTE FUNCTION assessment_link_frozen();
CREATE TRIGGER assessment_run_immutable BEFORE UPDATE OR DELETE ON "AssessmentAutomationRun" FOR EACH ROW EXECUTE FUNCTION assessment_append_only();

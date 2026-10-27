-- Preserve published interview evidence and serialize revisions within each family.
ALTER TABLE scorecard_templates ADD COLUMN "familyId" uuid NOT NULL DEFAULT gen_random_uuid(), ADD COLUMN revision integer NOT NULL DEFAULT 0;
ALTER TABLE "InterviewQuestion" ADD COLUMN "familyId" uuid NOT NULL DEFAULT gen_random_uuid(), ADD COLUMN revision integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX scorecard_template_family_version ON scorecard_templates ("tenantId", "familyId", version);
CREATE UNIQUE INDEX interview_question_family_version ON "InterviewQuestion" ("tenantId", "familyId", version);
CREATE OR REPLACE FUNCTION hr_guard_evaluation_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status IN ('PUBLISHED','RETIRED') THEN RAISE EXCEPTION 'HR-6006: Published evaluation evidence cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."familyId" IS DISTINCT FROM OLD."familyId" OR NEW.version IS DISTINCT FROM OLD.version THEN
  RAISE EXCEPTION 'HR-6006: Evaluation identity is immutable';
 END IF;
 IF OLD.status IN ('PUBLISHED','RETIRED') AND
    (to_jsonb(NEW) - ARRAY['revision','status','isActive','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['revision','status','isActive','updated_at']) THEN
  RAISE EXCEPTION 'HR-6006: Published evaluation content is immutable';
 END IF;
 IF OLD.status='RETIRED' AND NEW.status<>'RETIRED' OR OLD.status='PUBLISHED' AND NEW.status NOT IN ('PUBLISHED','RETIRED') THEN
  RAISE EXCEPTION 'HR-6006: Create a revised draft';
 END IF;
 NEW.revision := OLD.revision+1;
 RETURN NEW;
END $$;
CREATE TRIGGER scorecard_template_evidence_guard BEFORE UPDATE OR DELETE ON scorecard_templates FOR EACH ROW WHEN (OLD.sections IS NOT NULL) EXECUTE FUNCTION hr_guard_evaluation_catalog();
CREATE TRIGGER interview_question_evidence_guard BEFORE UPDATE OR DELETE ON "InterviewQuestion" FOR EACH ROW EXECUTE FUNCTION hr_guard_evaluation_catalog();

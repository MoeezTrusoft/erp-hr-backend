-- Assessment items may use a platform canonical skill or a skill in their company.
-- The former composite FK could not reference the platform's NULL tenant row.
ALTER TABLE "CandidateTestItem" DROP CONSTRAINT "CandidateTestItem_skillId_tenant_fk";
ALTER TABLE "CandidateTestItem" ADD CONSTRAINT "CandidateTestItem_skillId_fk" FOREIGN KEY ("skillId") REFERENCES skills(id) ON DELETE RESTRICT;
CREATE OR REPLACE FUNCTION public.guard_assessment_item_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenantId" IS NULL OR NOT EXISTS (SELECT 1 FROM public.skills s WHERE s.id=NEW."skillId" AND (s."tenantId" IS NULL OR s."tenantId"=NEW."tenantId")) THEN
    RAISE EXCEPTION 'HR-6006: Assessment skill must be canonical or belong to this company';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW."gradeLevelIds") AS g(id) WHERE NOT EXISTS (SELECT 1 FROM public."GradeLevel" gl WHERE gl.id=g.id AND gl."tenantId"=NEW."tenantId")) THEN
    RAISE EXCEPTION 'HR-6006: Assessment grade must belong to this company';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assessment_item_references BEFORE INSERT OR UPDATE OF "tenantId","skillId","gradeLevelIds" ON "CandidateTestItem" FOR EACH ROW EXECUTE FUNCTION public.guard_assessment_item_references();
-- Moving a canonical skill into a company would invalidate any global references.
-- Company ownership is immutable; correction means creating an appropriate new skill.
CREATE OR REPLACE FUNCTION public.guard_skill_company_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."tenantId" IS DISTINCT FROM NEW."tenantId" THEN RAISE EXCEPTION 'HR-6006: Skill company ownership is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_company_ownership BEFORE UPDATE OF "tenantId" ON skills FOR EACH ROW EXECUTE FUNCTION public.guard_skill_company_ownership();

-- Grade arrays remain valid even when catalogue administrators retire reference data.
CREATE OR REPLACE FUNCTION public.guard_assessment_grade_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
    IF EXISTS (SELECT 1 FROM public."CandidateTestItem" i WHERE OLD.id=ANY(i."gradeLevelIds") AND i."tenantId"=OLD."tenantId") THEN
      RAISE EXCEPTION 'HR-6006: A referenced assessment grade cannot be deleted or moved';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assessment_grade_reference BEFORE DELETE OR UPDATE OF "tenantId" ON "GradeLevel" FOR EACH ROW EXECUTE FUNCTION public.guard_assessment_grade_reference();

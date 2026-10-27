ALTER TABLE "Application" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION hr_candidate_test_response_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "CandidateTestSession";
BEGIN
 SELECT * INTO s FROM "CandidateTestSession" WHERE id=NEW."sessionId" AND "tenantId"=NEW."tenantId" FOR UPDATE;
 IF s.id IS NULL OR s.status<>'IN_PROGRESS' OR s."deadlineAt"<=(clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'HR-6009: session is not accepting answers'; END IF;
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s."itemOrder") i WHERE (i->>'itemId')::integer=NEW."itemId" AND (i->>'itemVersion')::integer=NEW."itemVersion") THEN RAISE EXCEPTION 'HR-6009: item was not assigned to this session'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hr_candidate_test_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='PUBLISHED' AND NEW.status NOT IN ('PUBLISHED','RETIRED') THEN RAISE EXCEPTION 'HR-6008: published versions cannot return to draft'; END IF;
 IF OLD.status IN ('PUBLISHED','RETIRED') AND (to_jsonb(OLD)-ARRAY['status','revision','updatedAt','exposureCount','reviewComment']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','revision','updatedAt','exposureCount','reviewComment']) THEN RAISE EXCEPTION 'HR-6008: published assessment versions are immutable'; END IF;
 IF OLD.status='RETIRED' AND NEW.status<>'RETIRED' THEN RAISE EXCEPTION 'HR-6008: retired versions cannot be republished'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION hr_candidate_session_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."startedAt" IS NOT NULL AND (OLD."itemOrder" IS DISTINCT FROM NEW."itemOrder" OR OLD."blueprintSnapshot" IS DISTINCT FROM NEW."blueprintSnapshot" OR OLD."candidateId"<>NEW."candidateId" OR OLD."applicationId"<>NEW."applicationId" OR OLD."interviewId"<>NEW."interviewId") THEN
 RAISE EXCEPTION 'HR-6008: started assessment content is frozen'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_session_freeze BEFORE UPDATE ON "CandidateTestSession" FOR EACH ROW EXECUTE FUNCTION hr_candidate_session_freeze();
CREATE FUNCTION hr_candidate_summary_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-'pdfMediaId') IS DISTINCT FROM (to_jsonb(NEW)-'pdfMediaId') THEN RAISE EXCEPTION 'HR-6102: evaluation snapshot is frozen'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_summary_freeze BEFORE UPDATE ON "CandidateEvaluationSummary" FOR EACH ROW EXECUTE FUNCTION hr_candidate_summary_freeze();
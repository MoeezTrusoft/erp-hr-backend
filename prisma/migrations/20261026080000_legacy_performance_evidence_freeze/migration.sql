-- Serialize every child edit with the approval adapter's parent row lock.
-- This also protects writes from older services and direct runtime SQL.
CREATE FUNCTION perf_legacy_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_id integer; tenant_id uuid; review_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."reviewId" IS DISTINCT FROM OLD."reviewId"
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId") THEN
    RAISE EXCEPTION 'Legacy appraisal evidence association is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    review_id := OLD."reviewId"; tenant_id := OLD."tenantId";
  ELSE
    review_id := NEW."reviewId"; tenant_id := NEW."tenantId";
  END IF;
  SELECT status::text INTO review_status FROM "PerformanceReview"
    WHERE id=review_id AND "tenantId" IS NOT DISTINCT FROM tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Appraisal review is not accessible in this company' USING ERRCODE='23514';
  END IF;
  IF review_status='FINALIZED' THEN
    RAISE EXCEPTION 'Finalized appraisal evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER perf_legacy_items_frozen BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceReviewItem"
FOR EACH ROW EXECUTE FUNCTION perf_legacy_evidence_guard();
CREATE TRIGGER perf_legacy_feedback_frozen BEFORE INSERT OR UPDATE OR DELETE ON "ReviewFeedback"
FOR EACH ROW EXECUTE FUNCTION perf_legacy_evidence_guard();

-- Parent row locks close the check-then-write window between archival,
-- configuration edits and creation of dependent legacy appraisal records.
-- These guards run with the caller's RLS context, never SECURITY DEFINER.
CREATE FUNCTION perf_legacy_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'archivedAt' - 'updated_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'archivedAt' - 'updated_at') AND EXISTS (
      SELECT 1 FROM "PerformanceCycle" WHERE "templateId"=OLD.id
        AND "tenantId" IS NOT DISTINCT FROM OLD."tenantId") THEN
    RAISE EXCEPTION 'Referenced appraisal templates are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER perf_legacy_template_referenced BEFORE UPDATE ON "PerformanceTemplate"
FOR EACH ROW EXECUTE FUNCTION perf_legacy_template_guard();

CREATE FUNCTION perf_legacy_cycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_archived timestamptz;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW) - 'archivedAt' - 'updated_at') IS DISTINCT FROM
       (to_jsonb(OLD) - 'archivedAt' - 'updated_at') AND EXISTS (
        SELECT 1 FROM "PerformanceReview" WHERE "cycleId"=OLD.id
          AND "tenantId" IS NOT DISTINCT FROM OLD."tenantId") THEN
      RAISE EXCEPTION 'Launched appraisal cycle configuration is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW."templateId" IS NOT NULL AND (TG_OP='INSERT' OR NEW."templateId" IS DISTINCT FROM OLD."templateId"
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId") THEN
    SELECT "archivedAt" INTO parent_archived FROM "PerformanceTemplate"
      WHERE id=NEW."templateId" AND "tenantId" IS NOT DISTINCT FROM NEW."tenantId" FOR UPDATE;
    IF NOT FOUND OR parent_archived IS NOT NULL THEN
      RAISE EXCEPTION 'Active appraisal template required in this company' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER perf_legacy_cycle_parent BEFORE INSERT OR UPDATE ON "PerformanceCycle"
FOR EACH ROW EXECUTE FUNCTION perf_legacy_cycle_guard();

CREATE FUNCTION perf_legacy_review_cycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_archived timestamptz;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW."cycleId" IS NOT DISTINCT FROM OLD."cycleId"
        AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId" THEN RETURN NEW; END IF;
  END IF;
  IF NEW."cycleId" IS NOT NULL THEN
    SELECT "archivedAt" INTO parent_archived FROM "PerformanceCycle"
      WHERE id=NEW."cycleId" AND "tenantId" IS NOT DISTINCT FROM NEW."tenantId" FOR UPDATE;
    IF NOT FOUND OR parent_archived IS NOT NULL THEN
      RAISE EXCEPTION 'Active appraisal cycle required in this company' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER perf_legacy_review_cycle_parent BEFORE INSERT OR UPDATE ON "PerformanceReview"
FOR EACH ROW EXECUTE FUNCTION perf_legacy_review_cycle_guard();

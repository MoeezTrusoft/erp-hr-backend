-- Stop for reviewed reconciliation rather than deleting or renaming employee
-- history to make an index succeed. The transaction rolls back on conflict.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "PerformanceReview"
    WHERE "tenantId" IS NOT NULL AND "employeeId" IS NOT NULL AND "cycleId" IS NOT NULL
    GROUP BY "tenantId", "employeeId", "cycleId", type HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Legacy appraisal duplicate reviews require reviewed reconciliation';
  END IF;
  IF EXISTS (SELECT 1 FROM "GoalAlignment"
    WHERE "tenantId" IS NOT NULL AND "parentGoalId" IS NOT NULL AND "alignedGoalId" IS NOT NULL
    GROUP BY "tenantId", "parentGoalId", "alignedGoalId" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Legacy appraisal duplicate goal edges require reviewed reconciliation';
  END IF;
  IF EXISTS (SELECT 1 FROM "PerformanceMetric" WHERE "tenantId" IS NOT NULL
    GROUP BY "tenantId", name HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Legacy appraisal duplicate metrics require reviewed reconciliation';
  END IF;
END $$;

ALTER TABLE "PerformanceCycle" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "PerformanceTemplate" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "GoalAlignment" ADD COLUMN "archivedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "PerformanceReview_tenantId_employeeId_cycleId_type_key"
  ON "PerformanceReview"("tenantId", "employeeId", "cycleId", type);
CREATE UNIQUE INDEX "GoalAlignment_tenantId_parentGoalId_alignedGoalId_key"
  ON "GoalAlignment"("tenantId", "parentGoalId", "alignedGoalId");
CREATE UNIQUE INDEX "PerformanceMetric_tenantId_name_key"
  ON "PerformanceMetric"("tenantId", name);

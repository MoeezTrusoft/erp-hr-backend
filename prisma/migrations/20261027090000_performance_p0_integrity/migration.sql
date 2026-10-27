-- PERF-P0 (E-02 / E-05): integrity guards for the legacy performance-appraisal
-- tables. Additive (expand) only — no data is rewritten.
--
-- The unique index on PerformanceReview requires that no tenant holds two
-- reviews of the same type for one employee in one cycle. Check before deploy:
--   SELECT "tenantId","employeeId","cycleId","type",count(*) FROM "PerformanceReview"
--   WHERE "cycleId" IS NOT NULL GROUP BY 1,2,3,4 HAVING count(*) > 1;
-- and resolve any row the query returns (HR decides which review stands).

-- Soft delete columns
ALTER TABLE "PerformanceCycle" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "PerformanceTemplate" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "GoalAlignment" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Uniqueness and indexes
CREATE UNIQUE INDEX "PerformanceReview_tenantId_employeeId_cycleId_type_key" ON "PerformanceReview"("tenantId", "employeeId", "cycleId", "type");
CREATE UNIQUE INDEX "GoalAlignment_tenantId_parentGoalId_alignedGoalId_key" ON "GoalAlignment"("tenantId", "parentGoalId", "alignedGoalId");
CREATE UNIQUE INDEX "PerformanceMetric_tenantId_name_key" ON "PerformanceMetric"("tenantId", "name");
CREATE INDEX "PerformanceMetric_tenantId_idx" ON "PerformanceMetric"("tenantId");
CREATE INDEX "Goal_tenantId_employeeId_idx" ON "Goal"("tenantId", "employeeId");

-- Finalization guard: NOT added here. Migration 20261015120000_hr_approval_workflow
-- already installs hr_approval_guard on "PerformanceReview", which rejects any
-- status write to FINALIZED outside the HR Approval Centre with HR-4201. The
-- application layer (E-02) no longer accepts a status on review updates either.

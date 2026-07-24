-- Onboarding Portal wave (FE new-employee portal)
-- 1. OnboardingTaskCategory enum
-- 2. onboarding_tasks.category column (default OTHER) + assigneeId index
-- 3. onboarding_feedback table (radio questionnaire) with FORCE-RLS
--
-- Additive + idempotent. Applied via the fleet's raw-SQL runner (node-pg), NOT
-- `prisma migrate deploy`. CREATE TYPE cannot be wrapped with dependent DDL in
-- the same implicit tx cleanly on some PG versions, so it is guarded with a
-- DO-block existence check rather than a transaction.

-- 1. Enum ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OnboardingTaskCategory') THEN
    CREATE TYPE "OnboardingTaskCategory" AS ENUM (
      'IT_ACCESS_SETUP',
      'WORKSPACE_EQUIPMENT',
      'ORIENTATION_TRAINING',
      'HR_DOCUMENTATION',
      'TEAM_INTRODUCTION',
      'COMPLIANCE_POLICY',
      'OTHER'
    );
  END IF;
END$$;

-- 2. onboarding_tasks.category + index ---------------------------------------
ALTER TABLE "onboarding_tasks"
  ADD COLUMN IF NOT EXISTS "category" "OnboardingTaskCategory" DEFAULT 'OTHER';

CREATE INDEX IF NOT EXISTS "onboarding_tasks_assigneeId_idx"
  ON "onboarding_tasks" ("assigneeId");

-- 3. onboarding_feedback table -----------------------------------------------
CREATE TABLE IF NOT EXISTS "onboarding_feedback" (
  "id"          SERIAL PRIMARY KEY,
  "checklistId" INTEGER NOT NULL,
  "employeeId"  INTEGER NOT NULL,
  "responses"   JSONB,
  "comments"    TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"    UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "onboarding_feedback_checklistId_fkey"
    FOREIGN KEY ("checklistId") REFERENCES "onboarding_checklists"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_feedback_checklistId_key"
  ON "onboarding_feedback" ("checklistId");
CREATE INDEX IF NOT EXISTS "onboarding_feedback_tenantId_idx"
  ON "onboarding_feedback" ("tenantId");
CREATE INDEX IF NOT EXISTS "onboarding_feedback_employeeId_idx"
  ON "onboarding_feedback" ("employeeId");

-- FORCE-RLS on the new table (fleet pattern) ---------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "onboarding_feedback" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "onboarding_feedback_id_seq" TO hr_app;

ALTER TABLE "onboarding_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "onboarding_feedback" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "onboarding_feedback";
CREATE POLICY "tenant_isolation" ON "onboarding_feedback"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

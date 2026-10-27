-- Phase 5 / decision record §3.5 — per-requisition application questions and
-- the candidate answers to them.
--
-- Recruiter-defined screening questions live on the requisition; answers live
-- on the application and point at the exact QUESTION ROW they answered, so a
-- later edit or deactivation can never silently reinterpret stored answers.

CREATE TABLE "application_questions" (
    "id"            SERIAL PRIMARY KEY,
    "requisitionId" INTEGER NOT NULL,
    "version"       INTEGER NOT NULL DEFAULT 1,
    "orderIndex"    INTEGER NOT NULL DEFAULT 0,
    "type"          TEXT NOT NULL,
    "prompt"        TEXT NOT NULL,
    "required"      BOOLEAN NOT NULL DEFAULT false,
    "options"       JSONB,
    "weights"       JSONB,
    "maxScore"      INTEGER,
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "tenantId"      UUID,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL
);

CREATE TABLE "application_answers" (
    "id"            SERIAL PRIMARY KEY,
    "applicationId" INTEGER NOT NULL,
    "questionId"    INTEGER NOT NULL,
    "value"         JSONB,
    "score"         INTEGER,
    "answeredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- FKs. Answers cascade with their application (erasing an application takes its
-- answers); questions RESTRICT on requisition delete so a requisition cannot
-- vanish while it is the key a historical answer set points at.
ALTER TABLE "application_questions"
    ADD CONSTRAINT "application_questions_requisitionId_fkey"
    FOREIGN KEY ("requisitionId") REFERENCES "JobRequisition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "application_answers"
    ADD CONSTRAINT "application_answers_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "application_answers"
    ADD CONSTRAINT "application_answers_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "application_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reads: the portal fetches the ACTIVE question set for a requisition in
-- display order; the recruiter admin lists by requisition.
CREATE INDEX IF NOT EXISTS "application_questions_requisitionId_version_orderIndex_idx"
    ON "application_questions" ("requisitionId", "version", "orderIndex");
CREATE INDEX IF NOT EXISTS "application_questions_tenantId_idx" ON "application_questions" ("tenantId");
CREATE INDEX IF NOT EXISTS "application_answers_applicationId_idx" ON "application_answers" ("applicationId");
CREATE INDEX IF NOT EXISTS "application_answers_questionId_idx" ON "application_answers" ("questionId");

-- One answer per application per question (resubmission updates in place).
CREATE UNIQUE INDEX IF NOT EXISTS "application_answers_applicationId_questionId_key"
    ON "application_answers" ("applicationId", "questionId");

-- The closed type vocabulary. Adding a type is a constraint change plus the
-- lib list — deliberately NOT a Prisma enum, same reasoning as the posting
-- channels: this vocabulary is read by the public portal.
ALTER TABLE "application_questions" DROP CONSTRAINT IF EXISTS "application_questions_type_check";
ALTER TABLE "application_questions" ADD CONSTRAINT "application_questions_type_check"
    CHECK ("type" IN ('TEXT_SHORT', 'TEXT_LONG', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'NUMBER', 'BOOLEAN', 'DATE'));

-- A scored question must declare its ceiling: weights without maxScore would
-- let a renderer guess the ceiling and a report normalize against the wrong
-- number. maxScore without weights is allowed (a manually-totalled score).
ALTER TABLE "application_questions" DROP CONSTRAINT IF EXISTS "application_questions_score_consistency_check";
ALTER TABLE "application_questions" ADD CONSTRAINT "application_questions_score_consistency_check"
    CHECK ("weights" IS NULL OR "maxScore" IS NOT NULL);

-- ── F-DB-05 convention: staged NOT VALID backfill + own RLS policy ──────────
-- ApplicationQuestion carries the nullable-tenantId convention of every other
-- recruitment table (a legacy tenantless requisition must not fail its question
-- write on a NOT NULL column), so it joins the staged-backfill cohort and — like
-- RecruitmentHiringFreeze and RequisitionApprovalRule — carries its own policy
-- in the migration that creates it.
ALTER TABLE "application_questions" ADD CONSTRAINT "application_questions_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "application_questions" TO hr_app;
ALTER TABLE "application_questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_questions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "application_questions";
CREATE POLICY tenant_isolation ON "application_questions"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

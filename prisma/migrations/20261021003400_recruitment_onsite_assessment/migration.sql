-- Recruitment Phase 3b — on-site assessment and evaluation forms.
--
-- Columns on existing tables:
--   Employee                     interviewerTrainedAt (forms that require a
--                                trained interviewer)
--   interviews                   assessment requirement and status, the
--                                blueprint, a waiver's reason and actor, the
--                                evaluation form version pinned at scheduling
--   interview_interviewers       panelRole
--   interview_scorecards         pinned template version, DRAFT/SUBMITTED
--                                (rows already submitted are backfilled),
--                                criterion scores, weighted score, must-have
--                                failure, conflict-of-interest declaration,
--                                autosave stamps, prohibited-topic flag
--   scorecard_templates          versions by templateKey, status (existing rows
--                                PUBLISHED v1), interview type and panel role,
--                                scale, sections with anchors and weights,
--                                evidence rules, trained-interviewer flag
--   tenant_recruitment_settings  kioskShowScore
--
-- New tables, NOT NULL tenant and FORCE row-level security: the item bank and
-- its statistics, blueprints and their links, kiosk workstations, check-ins,
-- test sessions, responses, integrity events, results, the interview question
-- bank and frozen evaluation summaries.
--
-- Additive only; the one data change is the scorecard status backfill.

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "interviewerTrainedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "interviews" ADD COLUMN     "assessmentBlueprintId" INTEGER,
ADD COLUMN     "assessmentRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "assessmentStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "assessmentWaivedById" INTEGER,
ADD COLUMN     "assessmentWaivedReason" TEXT,
ADD COLUMN     "formTemplateId" INTEGER,
ADD COLUMN     "formTemplateVersion" INTEGER;

-- AlterTable
ALTER TABLE "interview_interviewers" ADD COLUMN     "panelRole" TEXT;

-- AlterTable
ALTER TABLE "interview_scorecards" ADD COLUMN     "coiDeclared" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "criterionScores" JSONB,
ADD COLUMN     "draftSavedAt" TIMESTAMP(3),
ADD COLUMN     "mustHaveFailed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notesFlagTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "notesFlagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "templateId" INTEGER,
ADD COLUMN     "templateVersion" INTEGER,
ADD COLUMN     "weightedScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "scorecard_templates" ADD COLUMN     "evidenceRules" JSONB,
ADD COLUMN     "interviewType" TEXT,
ADD COLUMN     "panelRole" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "requiresTrainedInterviewer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scale" JSONB,
ADD COLUMN     "sections" JSONB,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN     "templateKey" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "tenant_recruitment_settings" ADD COLUMN     "kioskShowScore" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "candidate_test_items" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "itemCode" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "type" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "mediaId" INTEGER,
    "options" JSONB,
    "answerKey" TEXT NOT NULL,
    "scoringRule" JSONB,
    "difficulty" TEXT NOT NULL,
    "competencyKey" TEXT NOT NULL,
    "skillId" INTEGER,
    "jobFamily" TEXT,
    "gradeLevelIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "language" TEXT NOT NULL DEFAULT 'en',
    "timeEstimateSec" INTEGER,
    "rationale" TEXT,
    "discussionPrompt" BOOLEAN NOT NULL DEFAULT false,
    "aiDrafted" BOOLEAN NOT NULL DEFAULT false,
    "authorId" INTEGER,
    "reviewerId" INTEGER,
    "reviewComment" TEXT,
    "submittedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "exposureCount" INTEGER NOT NULL DEFAULT 0,
    "exposureCap" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_test_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_test_item_stats" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "itemId" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "difficulty" DOUBLE PRECISION,
    "discrimination" DOUBLE PRECISION,
    "distractorRates" JSONB,
    "avgTimeSec" DOUBLE PRECISION,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_test_item_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_test_blueprints" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "blueprintKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "language" TEXT NOT NULL DEFAULT 'en',
    "jobFamily" TEXT,
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "passMarkPct" INTEGER NOT NULL DEFAULT 60,
    "borderlineBandPct" INTEGER NOT NULL DEFAULT 10,
    "hardFloorPct" INTEGER,
    "autoReleaseBelowFloor" BOOLEAN NOT NULL DEFAULT false,
    "negativeMarking" BOOLEAN NOT NULL DEFAULT false,
    "negativeMarkFraction" DOUBLE PRECISION,
    "navigation" TEXT NOT NULL DEFAULT 'FREE',
    "flagForReview" BOOLEAN NOT NULL DEFAULT true,
    "sections" JSONB NOT NULL,
    "retakeCooldownDays" INTEGER NOT NULL DEFAULT 180,
    "resultValidityDays" INTEGER NOT NULL DEFAULT 90,
    "testWeightPct" INTEGER NOT NULL DEFAULT 30,
    "integrityFlagThreshold" INTEGER NOT NULL DEFAULT 3,
    "maxExtraTimePct" INTEGER NOT NULL DEFAULT 50,
    "allowAnySiteKiosk" BOOLEAN NOT NULL DEFAULT false,
    "approvedByHiringManagerId" INTEGER,
    "hiringManagerApprovedAt" TIMESTAMP(3),
    "approvedByHrId" INTEGER,
    "hrApprovedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_test_blueprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_test_blueprint_links" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "blueprintId" INTEGER NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" INTEGER,
    "scopeKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_test_blueprint_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_workstations" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "siteRef" TEXT NOT NULL,
    "deviceTokenHash" TEXT NOT NULL,
    "tokenRotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastSeenAt" TIMESTAMP(3),
    "registeredById" INTEGER,
    "revokedAt" TIMESTAMP(3),
    "revokedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_workstations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_checkins" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "interviewId" INTEGER NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "siteRef" TEXT,
    "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idType" TEXT,
    "idLast4" TEXT,
    "verifiedById" INTEGER,
    "consentAt" TIMESTAMP(3),
    "photoMediaId" INTEGER,
    "accommodations" JSONB,
    "accommodationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_checkins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_test_sessions" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "interviewId" INTEGER NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "checkInId" INTEGER,
    "blueprintId" INTEGER NOT NULL,
    "blueprintVersion" INTEGER NOT NULL,
    "workstationId" INTEGER,
    "siteRef" TEXT,
    "sessionCodeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "sessionTokenHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "previousSessionId" INTEGER,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" INTEGER,
    "consentAt" TIMESTAMP(3),
    "practiceDoneAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pausedTotalSec" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "submitReason" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "extraTimePct" INTEGER NOT NULL DEFAULT 0,
    "itemOrder" JSONB,
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_test_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_test_responses" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "itemVersion" INTEGER NOT NULL,
    "answer" JSONB NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeSpentSec" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "candidate_test_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_test_integrity_events" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'KIOSK',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" JSONB,

    CONSTRAINT "candidate_test_integrity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_test_results" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "interviewId" INTEGER NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "blueprintId" INTEGER NOT NULL,
    "jobFamily" TEXT,
    "rawScore" DOUBLE PRECISION NOT NULL,
    "maxScore" DOUBLE PRECISION NOT NULL,
    "scorePct" DOUBLE PRECISION NOT NULL,
    "sectionScores" JSONB NOT NULL,
    "mustPassFailed" BOOLEAN NOT NULL DEFAULT false,
    "band" TEXT NOT NULL,
    "percentile" DOUBLE PRECISION,
    "integrityFlagCount" INTEGER NOT NULL DEFAULT 0,
    "timeTakenSec" INTEGER,
    "decision" TEXT,
    "decidedById" INTEGER,
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_questions" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "questionKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "competencyKey" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "followUps" JSONB,
    "goodAnswerGuide" TEXT,
    "level" TEXT,
    "aiDrafted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_evaluation_summaries" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "interviewId" INTEGER NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "testScorePct" DOUBLE PRECISION,
    "interviewScorePct" DOUBLE PRECISION,
    "compositeScore" DOUBLE PRECISION,
    "weights" JSONB NOT NULL,
    "rankAtSnapshot" INTEGER,
    "pdfMediaId" INTEGER,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozenById" INTEGER,

    CONSTRAINT "candidate_evaluation_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "candidate_test_items_tenantId_status_competencyKey_idx" ON "candidate_test_items"("tenantId", "status", "competencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_test_items_tenantId_itemCode_version_key" ON "candidate_test_items"("tenantId", "itemCode", "version");

-- CreateIndex
CREATE INDEX "candidate_test_item_stats_tenantId_idx" ON "candidate_test_item_stats"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_test_item_stats_itemId_period_key" ON "candidate_test_item_stats"("itemId", "period");

-- CreateIndex
CREATE INDEX "candidate_test_blueprints_tenantId_status_idx" ON "candidate_test_blueprints"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_test_blueprints_tenantId_blueprintKey_version_key" ON "candidate_test_blueprints"("tenantId", "blueprintKey", "version");

-- CreateIndex
CREATE INDEX "candidate_test_blueprint_links_tenantId_scopeType_scopeId_s_idx" ON "candidate_test_blueprint_links"("tenantId", "scopeType", "scopeId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "test_workstations_deviceTokenHash_key" ON "test_workstations"("deviceTokenHash");

-- CreateIndex
CREATE INDEX "test_workstations_tenantId_siteRef_status_idx" ON "test_workstations"("tenantId", "siteRef", "status");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_checkins_interviewId_key" ON "candidate_checkins"("interviewId");

-- CreateIndex
CREATE INDEX "candidate_checkins_tenantId_arrivedAt_idx" ON "candidate_checkins"("tenantId", "arrivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_test_sessions_sessionCodeHash_key" ON "candidate_test_sessions"("sessionCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_test_sessions_sessionTokenHash_key" ON "candidate_test_sessions"("sessionTokenHash");

-- CreateIndex
CREATE INDEX "candidate_test_sessions_tenantId_interviewId_idx" ON "candidate_test_sessions"("tenantId", "interviewId");

-- CreateIndex
CREATE INDEX "candidate_test_sessions_status_codeExpiresAt_idx" ON "candidate_test_sessions"("status", "codeExpiresAt");

-- CreateIndex
CREATE INDEX "candidate_test_sessions_status_deadlineAt_idx" ON "candidate_test_sessions"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "candidate_test_responses_tenantId_idx" ON "candidate_test_responses"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_test_responses_sessionId_itemId_key" ON "candidate_test_responses"("sessionId", "itemId");

-- CreateIndex
CREATE INDEX "candidate_test_integrity_events_tenantId_idx" ON "candidate_test_integrity_events"("tenantId");

-- CreateIndex
CREATE INDEX "candidate_test_integrity_events_sessionId_occurredAt_idx" ON "candidate_test_integrity_events"("sessionId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_test_results_sessionId_key" ON "candidate_test_results"("sessionId");

-- CreateIndex
CREATE INDEX "candidate_test_results_tenantId_interviewId_idx" ON "candidate_test_results"("tenantId", "interviewId");

-- CreateIndex
CREATE INDEX "candidate_test_results_tenantId_candidateId_jobFamily_idx" ON "candidate_test_results"("tenantId", "candidateId", "jobFamily");

-- CreateIndex
CREATE INDEX "interview_questions_tenantId_status_competencyKey_idx" ON "interview_questions"("tenantId", "status", "competencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "interview_questions_tenantId_questionKey_version_key" ON "interview_questions"("tenantId", "questionKey", "version");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_evaluation_summaries_interviewId_key" ON "candidate_evaluation_summaries"("interviewId");

-- CreateIndex
CREATE INDEX "candidate_evaluation_summaries_tenantId_requisitionId_idx" ON "candidate_evaluation_summaries"("tenantId", "requisitionId");

-- AddForeignKey
ALTER TABLE "candidate_test_item_stats" ADD CONSTRAINT "candidate_test_item_stats_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "candidate_test_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_test_blueprint_links" ADD CONSTRAINT "candidate_test_blueprint_links_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "candidate_test_blueprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_test_responses" ADD CONSTRAINT "candidate_test_responses_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "candidate_test_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_test_responses" ADD CONSTRAINT "candidate_test_responses_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "candidate_test_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_test_integrity_events" ADD CONSTRAINT "candidate_test_integrity_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "candidate_test_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_test_results" ADD CONSTRAINT "candidate_test_results_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "candidate_test_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Backfill: a scorecard that was submitted is SUBMITTED ─────────────────
UPDATE "interview_scorecards" SET "status" = 'SUBMITTED' WHERE "submittedAt" IS NOT NULL;

-- ── One active blueprint link per scope ───────────────────────────────────
CREATE UNIQUE INDEX "candidate_test_blueprint_links_one_active_per_scope"
    ON "candidate_test_blueprint_links" ("tenantId", "scopeType", COALESCE("scopeId", 0), COALESCE("scopeKey", ''))
    WHERE "isActive";

-- ── Closed vocabularies (checked here, mirrored in the lib constants) ──────
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_assessmentStatus_check"
    CHECK ("assessmentStatus" IN ('NOT_REQUIRED', 'REQUIRED', 'CHECKED_IN', 'IN_PROGRESS', 'PASSED', 'BORDERLINE',
                                  'FAILED', 'REVIEW', 'INCOMPLETE', 'RELEASED', 'OVERRIDDEN', 'WAIVED'));
ALTER TABLE "interview_interviewers" ADD CONSTRAINT "interview_interviewers_panelRole_check"
    CHECK ("panelRole" IS NULL OR "panelRole" IN ('TECHNICAL', 'HIRING_MANAGER', 'HR', 'CULTURE'));
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_status_check"
    CHECK ("status" IN ('DRAFT', 'SUBMITTED'));
ALTER TABLE "scorecard_templates" ADD CONSTRAINT "scorecard_templates_status_check"
    CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'RETIRED'));
ALTER TABLE "scorecard_templates" ADD CONSTRAINT "scorecard_templates_version_check"
    CHECK ("version" >= 1);

-- A release cancels the interview with reason ASSESSMENT_NOT_PASSED.
ALTER TABLE "interview_lifecycle_events" DROP CONSTRAINT IF EXISTS "interview_lifecycle_events_reasoncode_check";
ALTER TABLE "interview_lifecycle_events" ADD CONSTRAINT "interview_lifecycle_events_reasoncode_check"
    CHECK ("reasonCode" IN ('CANDIDATE_REQUEST', 'INTERVIEWER_CONFLICT', 'BUSINESS_REQUEST',
                            'TECHNICAL_ISSUE', 'LOGISTICS_ISSUE', 'REQUISITION_CLOSED', 'OTHER',
                            'CANDIDATE_NO_SHOW', 'ASSESSMENT_NOT_PASSED'));

ALTER TABLE "candidate_test_items" ADD CONSTRAINT "candidate_test_items_status_check"
    CHECK ("status" IN ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED'));
ALTER TABLE "candidate_test_items" ADD CONSTRAINT "candidate_test_items_type_check"
    CHECK ("type" IN ('SINGLE', 'MULTI', 'TRUE_FALSE', 'NUMERIC', 'IMAGE_SINGLE'));
ALTER TABLE "candidate_test_items" ADD CONSTRAINT "candidate_test_items_difficulty_check"
    CHECK ("difficulty" IN ('EASY', 'MEDIUM', 'HARD'));
ALTER TABLE "candidate_test_items" ADD CONSTRAINT "candidate_test_items_language_check"
    CHECK ("language" IN ('en', 'ur'));
-- Four eyes: the reviewer who published an item is never its author.
ALTER TABLE "candidate_test_items" ADD CONSTRAINT "candidate_test_items_four_eyes_check"
    CHECK ("reviewerId" IS NULL OR "authorId" IS NULL OR "reviewerId" <> "authorId");
ALTER TABLE "candidate_test_items" ADD CONSTRAINT "candidate_test_items_counts_check"
    CHECK ("version" >= 1 AND "exposureCount" >= 0);

ALTER TABLE "candidate_test_blueprints" ADD CONSTRAINT "candidate_test_blueprints_status_check"
    CHECK ("status" IN ('DRAFT', 'IN_APPROVAL', 'APPROVED', 'PUBLISHED', 'RETIRED'));
ALTER TABLE "candidate_test_blueprints" ADD CONSTRAINT "candidate_test_blueprints_navigation_check"
    CHECK ("navigation" IN ('FREE', 'FORWARD_ONLY'));
ALTER TABLE "candidate_test_blueprints" ADD CONSTRAINT "candidate_test_blueprints_ranges_check"
    CHECK ("durationMin" BETWEEN 5 AND 240
       AND "passMarkPct" BETWEEN 0 AND 100
       AND "borderlineBandPct" BETWEEN 0 AND 100
       AND ("hardFloorPct" IS NULL OR "hardFloorPct" BETWEEN 0 AND 100)
       AND "testWeightPct" BETWEEN 0 AND 100
       AND "retakeCooldownDays" >= 0
       AND "resultValidityDays" >= 0
       AND "integrityFlagThreshold" >= 0
       AND "maxExtraTimePct" BETWEEN 0 AND 100
       AND "version" >= 1
       AND jsonb_typeof("sections") = 'array');

ALTER TABLE "candidate_test_blueprint_links" ADD CONSTRAINT "candidate_test_blueprint_links_scope_check"
    CHECK ("scopeType" IN ('REQUISITION', 'JOB_FAMILY_GRADE', 'JOB_FAMILY'));

ALTER TABLE "test_workstations" ADD CONSTRAINT "test_workstations_status_check"
    CHECK ("status" IN ('ACTIVE', 'REVOKED'));

-- ID verification keeps the last four characters at most.
ALTER TABLE "candidate_checkins" ADD CONSTRAINT "candidate_checkins_idLast4_check"
    CHECK ("idLast4" IS NULL OR char_length("idLast4") <= 4);

ALTER TABLE "candidate_test_sessions" ADD CONSTRAINT "candidate_test_sessions_status_check"
    CHECK ("status" IN ('ISSUED', 'IN_PROGRESS', 'PAUSED', 'SUBMITTED', 'EXPIRED', 'VOIDED'));
ALTER TABLE "candidate_test_sessions" ADD CONSTRAINT "candidate_test_sessions_submitReason_check"
    CHECK ("submitReason" IS NULL OR "submitReason" IN ('CANDIDATE', 'TIMEOUT', 'PROCTOR'));
ALTER TABLE "candidate_test_sessions" ADD CONSTRAINT "candidate_test_sessions_ranges_check"
    CHECK ("extraTimePct" BETWEEN 0 AND 100 AND "pausedTotalSec" >= 0 AND "attemptNo" >= 1);

ALTER TABLE "candidate_test_responses" ADD CONSTRAINT "candidate_test_responses_time_check"
    CHECK ("timeSpentSec" >= 0);

ALTER TABLE "candidate_test_integrity_events" ADD CONSTRAINT "candidate_test_integrity_events_type_check"
    CHECK ("type" IN ('FOCUS_LOST', 'FULLSCREEN_EXIT', 'NETWORK_LOSS', 'RAPID_ANSWER', 'DEVICE_CHANGE',
                      'PROCTOR_PAUSE', 'PROCTOR_VOID'));
ALTER TABLE "candidate_test_integrity_events" ADD CONSTRAINT "candidate_test_integrity_events_source_check"
    CHECK ("source" IN ('KIOSK', 'PROCTOR', 'SERVER'));

ALTER TABLE "candidate_test_results" ADD CONSTRAINT "candidate_test_results_band_check"
    CHECK ("band" IN ('PASSED', 'BORDERLINE', 'FAILED', 'REVIEW', 'INCOMPLETE'));
ALTER TABLE "candidate_test_results" ADD CONSTRAINT "candidate_test_results_decision_check"
    CHECK ("decision" IS NULL OR "decision" IN ('PROCEED', 'RELEASE', 'OVERRIDE', 'RETEST', 'WAIVE'));
ALTER TABLE "candidate_test_results" ADD CONSTRAINT "candidate_test_results_score_check"
    CHECK ("scorePct" >= 0 AND "scorePct" <= 100 AND "maxScore" >= 0);
-- Every decision other than PROCEED carries its reason.
ALTER TABLE "candidate_test_results" ADD CONSTRAINT "candidate_test_results_reason_check"
    CHECK ("decision" IS NULL OR "decision" = 'PROCEED' OR ("decisionReason" IS NOT NULL AND "decisionReason" <> ''));

ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_status_check"
    CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'RETIRED'));

-- ── Row-level security (same policy as every recruitment table) ────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_test_items" TO hr_app;
ALTER TABLE "candidate_test_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_test_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_test_items";
CREATE POLICY tenant_isolation ON "candidate_test_items"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_test_item_stats" TO hr_app;
ALTER TABLE "candidate_test_item_stats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_test_item_stats" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_test_item_stats";
CREATE POLICY tenant_isolation ON "candidate_test_item_stats"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_test_blueprints" TO hr_app;
ALTER TABLE "candidate_test_blueprints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_test_blueprints" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_test_blueprints";
CREATE POLICY tenant_isolation ON "candidate_test_blueprints"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_test_blueprint_links" TO hr_app;
ALTER TABLE "candidate_test_blueprint_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_test_blueprint_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_test_blueprint_links";
CREATE POLICY tenant_isolation ON "candidate_test_blueprint_links"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "test_workstations" TO hr_app;
ALTER TABLE "test_workstations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "test_workstations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "test_workstations";
CREATE POLICY tenant_isolation ON "test_workstations"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_checkins" TO hr_app;
ALTER TABLE "candidate_checkins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_checkins" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_checkins";
CREATE POLICY tenant_isolation ON "candidate_checkins"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_test_sessions" TO hr_app;
ALTER TABLE "candidate_test_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_test_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_test_sessions";
CREATE POLICY tenant_isolation ON "candidate_test_sessions"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_test_responses" TO hr_app;
ALTER TABLE "candidate_test_responses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_test_responses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_test_responses";
CREATE POLICY tenant_isolation ON "candidate_test_responses"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_test_integrity_events" TO hr_app;
ALTER TABLE "candidate_test_integrity_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_test_integrity_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_test_integrity_events";
CREATE POLICY tenant_isolation ON "candidate_test_integrity_events"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_test_results" TO hr_app;
ALTER TABLE "candidate_test_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_test_results" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_test_results";
CREATE POLICY tenant_isolation ON "candidate_test_results"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "interview_questions" TO hr_app;
ALTER TABLE "interview_questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_questions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "interview_questions";
CREATE POLICY tenant_isolation ON "interview_questions"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_evaluation_summaries" TO hr_app;
ALTER TABLE "candidate_evaluation_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_evaluation_summaries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_evaluation_summaries";
CREATE POLICY tenant_isolation ON "candidate_evaluation_summaries"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

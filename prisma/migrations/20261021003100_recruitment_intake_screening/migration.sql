-- Recruitment Phase 2 — intake and AI screening.
--
-- Columns on existing tables:
--   Application            source attribution (channel, posting, campaign
--                          detail), the deterministic answer total and the
--                          knockout outcome at intake
--   application_questions  knockout flag and rule
--   application_answers    per-answer knockout outcome
--   shortlist_entries      provenance (MANUAL | SCORING_PROPOSAL)
--   resume_parse_attempts  the asynchronous parse worker's candidate, due time
--                          and lease
--
-- New tables, all with a NOT NULL tenant and FORCE row-level security:
--   tenant_recruitment_settings       one row per tenant (absent = defaults)
--   scheduled_dispositions            reversible system dispositions (knockout)
--   application_scores                deterministic fit score + explanation
--   candidate_communications          every candidate message sent or suppressed
--   candidate_duplicate_suggestions   likely-duplicate candidate pairs
--
-- Additive only: no existing row changes meaning, every new column is nullable
-- or defaulted.

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "answerMaxScore" INTEGER,
ADD COLUMN     "answerScore" INTEGER,
ADD COLUMN     "knockedOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceChannel" TEXT,
ADD COLUMN     "sourceDetail" TEXT,
ADD COLUMN     "sourcePostingId" INTEGER;

-- AlterTable
ALTER TABLE "application_questions" ADD COLUMN     "knockout" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "knockoutRule" JSONB;

-- AlterTable
ALTER TABLE "application_answers" ADD COLUMN     "knockedOut" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "shortlist_entries" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "resume_parse_attempts" ADD COLUMN     "candidateId" INTEGER,
ADD COLUMN     "claimExpiresAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "tenant_recruitment_settings" (
    "tenantId" UUID NOT NULL,
    "defaultChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rejectionDelayHours" INTEGER NOT NULL DEFAULT 48,
    "knockoutDelayHours" INTEGER NOT NULL DEFAULT 24,
    "shortlistThreshold" INTEGER NOT NULL DEFAULT 70,
    "shortlistTopPercent" INTEGER NOT NULL DEFAULT 10,
    "feedEnabled" BOOLEAN NOT NULL DEFAULT false,
    "feedToken" TEXT,
    "companyName" TEXT,
    "companyUrl" TEXT,
    "companyLogoUrl" TEXT,
    "portalBaseUrl" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_recruitment_settings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "scheduled_dispositions" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "executeAt" TIMESTAMP(3) NOT NULL,
    "detail" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "executedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" INTEGER,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_dispositions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_scores" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "band" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "shortlistProposedAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_communications" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "applicationId" INTEGER,
    "requisitionId" INTEGER,
    "eventId" TEXT,
    "eventName" TEXT,
    "templateId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "category" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "suppressedReason" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "claimedBy" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "data" JSONB,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_duplicate_suggestions" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "candidateAId" INTEGER NOT NULL,
    "candidateBId" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "signals" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedById" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_duplicate_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_recruitment_settings_feedToken_key" ON "tenant_recruitment_settings"("feedToken");

-- CreateIndex
CREATE INDEX "scheduled_dispositions_status_executeAt_idx" ON "scheduled_dispositions"("status", "executeAt");

-- CreateIndex
CREATE INDEX "scheduled_dispositions_tenantId_idx" ON "scheduled_dispositions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_dispositions_applicationId_source_key" ON "scheduled_dispositions"("applicationId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "application_scores_applicationId_key" ON "application_scores"("applicationId");

-- CreateIndex
CREATE INDEX "application_scores_tenantId_requisitionId_score_idx" ON "application_scores"("tenantId", "requisitionId", "score");

-- CreateIndex
CREATE INDEX "candidate_communications_status_scheduledFor_idx" ON "candidate_communications"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "candidate_communications_tenantId_candidateId_createdAt_idx" ON "candidate_communications"("tenantId", "candidateId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_communications_tenantId_dedupeKey_key" ON "candidate_communications"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "candidate_duplicate_suggestions_tenantId_status_idx" ON "candidate_duplicate_suggestions"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_duplicate_suggestions_tenantId_candidateAId_candi_key" ON "candidate_duplicate_suggestions"("tenantId", "candidateAId", "candidateBId");

-- CreateIndex
CREATE INDEX "resume_parse_attempts_status_nextAttemptAt_idx" ON "resume_parse_attempts"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "scheduled_dispositions" ADD CONSTRAINT "scheduled_dispositions_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_scores" ADD CONSTRAINT "application_scores_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_communications" ADD CONSTRAINT "candidate_communications_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_duplicate_suggestions" ADD CONSTRAINT "candidate_duplicate_suggestions_candidateAId_fkey" FOREIGN KEY ("candidateAId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_duplicate_suggestions" ADD CONSTRAINT "candidate_duplicate_suggestions_candidateBId_fkey" FOREIGN KEY ("candidateBId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Closed vocabularies (checked here, mirrored in the lib constants) ──────
ALTER TABLE "Application" DROP CONSTRAINT IF EXISTS "Application_sourceChannel_check";
ALTER TABLE "Application" ADD CONSTRAINT "Application_sourceChannel_check"
    CHECK ("sourceChannel" IS NULL OR "sourceChannel" IN
        ('CAREER_SITE', 'LINKEDIN', 'INDEED', 'REFERRAL', 'AGENCY', 'TALENT_POOL', 'INTERNAL', 'RECRUITER', 'OTHER'));
ALTER TABLE "Application" DROP CONSTRAINT IF EXISTS "Application_sourceDetail_length_check";
ALTER TABLE "Application" ADD CONSTRAINT "Application_sourceDetail_length_check"
    CHECK ("sourceDetail" IS NULL OR char_length("sourceDetail") <= 200);

ALTER TABLE "shortlist_entries" DROP CONSTRAINT IF EXISTS "shortlist_entries_source_check";
ALTER TABLE "shortlist_entries" ADD CONSTRAINT "shortlist_entries_source_check"
    CHECK ("source" IN ('MANUAL', 'SCORING_PROPOSAL'));

ALTER TABLE "tenant_recruitment_settings" ADD CONSTRAINT "tenant_recruitment_settings_ranges_check"
    CHECK ("rejectionDelayHours" BETWEEN 0 AND 720
       AND "knockoutDelayHours" BETWEEN 0 AND 720
       AND "shortlistThreshold" BETWEEN 0 AND 100
       AND "shortlistTopPercent" BETWEEN 0 AND 100
       AND "version" >= 1);

ALTER TABLE "scheduled_dispositions" ADD CONSTRAINT "scheduled_dispositions_source_check"
    CHECK ("source" IN ('KNOCKOUT'));
ALTER TABLE "scheduled_dispositions" ADD CONSTRAINT "scheduled_dispositions_status_check"
    CHECK ("status" IN ('PENDING', 'EXECUTED', 'CANCELLED', 'FAILED'));

ALTER TABLE "application_scores" ADD CONSTRAINT "application_scores_score_check"
    CHECK ("score" >= 0 AND "score" <= 100);
ALTER TABLE "application_scores" ADD CONSTRAINT "application_scores_band_check"
    CHECK ("band" IN ('STRONG', 'GOOD', 'FAIR', 'WEAK'));

ALTER TABLE "candidate_communications" ADD CONSTRAINT "candidate_communications_status_check"
    CHECK ("status" IN ('QUEUED', 'SENT', 'SUPPRESSED', 'FAILED', 'CANCELLED'));
ALTER TABLE "candidate_communications" ADD CONSTRAINT "candidate_communications_category_check"
    CHECK ("category" IN ('STATUS', 'INTERVIEW', 'OFFER', 'REJECTION', 'MANUAL'));
ALTER TABLE "candidate_communications" ADD CONSTRAINT "candidate_communications_suppressed_check"
    CHECK ("suppressedReason" IS NULL OR "suppressedReason" IN
        ('DNC', 'CONSENT_WITHDRAWN', 'NO_EMAIL', 'ANONYMIZED', 'DISABLED'));

ALTER TABLE "candidate_duplicate_suggestions" ADD CONSTRAINT "candidate_duplicate_suggestions_status_check"
    CHECK ("status" IN ('OPEN', 'MERGED', 'DISMISSED'));
-- A pair is stored once, lower id first.
ALTER TABLE "candidate_duplicate_suggestions" ADD CONSTRAINT "candidate_duplicate_suggestions_order_check"
    CHECK ("candidateAId" < "candidateBId");

-- ── Row-level security (same policy as every recruitment table) ────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_recruitment_settings" TO hr_app;
ALTER TABLE "tenant_recruitment_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_recruitment_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_recruitment_settings";
CREATE POLICY tenant_isolation ON "tenant_recruitment_settings"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "scheduled_dispositions" TO hr_app;
ALTER TABLE "scheduled_dispositions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_dispositions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "scheduled_dispositions";
CREATE POLICY tenant_isolation ON "scheduled_dispositions"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "application_scores" TO hr_app;
ALTER TABLE "application_scores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_scores" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "application_scores";
CREATE POLICY tenant_isolation ON "application_scores"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_communications" TO hr_app;
ALTER TABLE "candidate_communications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_communications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_communications";
CREATE POLICY tenant_isolation ON "candidate_communications"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_duplicate_suggestions" TO hr_app;
ALTER TABLE "candidate_duplicate_suggestions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_duplicate_suggestions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_duplicate_suggestions";
CREATE POLICY tenant_isolation ON "candidate_duplicate_suggestions"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

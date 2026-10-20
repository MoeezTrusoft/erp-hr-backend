-- Recruitment Phase 3a — interview and offer orchestration.
--
-- Columns on existing tables:
--   interviews                   the calendar sync worker's action, retry state
--                                and lease; reminder pause, no-show and
--                                decision-prompt stamps; the slot offer the
--                                interview was created from
--   offers                       expiry reminder and expiry stamps, extension
--                                count, decline reason, note and talent pool
--                                opt-in
--   tenant_recruitment_settings  slot offer validity, the slot finder's working
--                                window and time zone, feedback nudge and
--                                escalation hours, offer reminder days
--
-- New tables, FORCE row-level security:
--   interview_slot_offers   slots offered to a candidate (hashed token)
--   interview_reminders     one row per reminder, nudge or prompt sent
--   offer_letter_templates  versioned tenant letter templates
--   offer_letter_versions   rendered letters and their signature round trip
--   esign_webhook_events    e-signature deliveries, deduplicated by event id
--                           (tenant unknown until the envelope is matched, so
--                           the column is nullable; only system context sees
--                           a row without one)
--
-- Additive only: every new column is nullable or defaulted.


-- AlterTable
ALTER TABLE "interviews" ADD COLUMN     "calendarClaimExpiresAt" TIMESTAMP(3),
ADD COLUMN     "calendarClaimedBy" TEXT,
ADD COLUMN     "calendarLastError" TEXT,
ADD COLUMN     "calendarNextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "calendarSyncAction" TEXT,
ADD COLUMN     "calendarSyncAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "decisionPromptedAt" TIMESTAMP(3),
ADD COLUMN     "noShowAt" TIMESTAMP(3),
ADD COLUMN     "remindersPausedAt" TIMESTAMP(3),
ADD COLUMN     "slotOfferId" INTEGER;

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "declineNote" TEXT,
ADD COLUMN     "declineReasonCode" TEXT,
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "expiryExtendedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "expiryReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "talentPoolOptIn" BOOLEAN;

-- AlterTable
ALTER TABLE "tenant_recruitment_settings" ADD COLUMN     "feedbackEscalationHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "feedbackNudgeHours" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "offerReminderDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "slotOfferValidityHours" INTEGER NOT NULL DEFAULT 72,
ADD COLUMN     "timeZone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
ADD COLUMN     "workdayEnd" TEXT NOT NULL DEFAULT '18:00',
ADD COLUMN     "workdayStart" TEXT NOT NULL DEFAULT '09:00';

-- CreateTable
CREATE TABLE "interview_slot_offers" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "interviewType" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "location" TEXT,
    "interviewerIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "slots" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "tokenHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "chosenSlotStart" TIMESTAMP(3),
    "interviewId" INTEGER,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_slot_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_reminders" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "interviewId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "recipientKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_letter_templates" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_letter_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_letter_versions" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "offerId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "mediaId" INTEGER,
    "contentHash" TEXT,
    "renderedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureStatus" TEXT NOT NULL DEFAULT 'NONE',
    "esignProvider" TEXT,
    "esignEnvelopeId" TEXT,
    "sentForSignatureAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signedMediaId" INTEGER,
    "signatureError" TEXT,

    CONSTRAINT "offer_letter_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esign_webhook_events" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "tenantId" UUID,
    "envelopeId" TEXT,
    "eventType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "esign_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "interview_slot_offers_tokenHash_key" ON "interview_slot_offers"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "interview_slot_offers_interviewId_key" ON "interview_slot_offers"("interviewId");

-- CreateIndex
CREATE INDEX "interview_slot_offers_tenantId_idx" ON "interview_slot_offers"("tenantId");

-- CreateIndex
CREATE INDEX "interview_slot_offers_applicationId_idx" ON "interview_slot_offers"("applicationId");

-- CreateIndex
CREATE INDEX "interview_slot_offers_status_expiresAt_idx" ON "interview_slot_offers"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "interview_reminders_tenantId_idx" ON "interview_reminders"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "interview_reminders_interviewId_kind_recipientKey_key" ON "interview_reminders"("interviewId", "kind", "recipientKey");

-- CreateIndex
CREATE INDEX "offer_letter_templates_tenantId_key_active_idx" ON "offer_letter_templates"("tenantId", "key", "active");

-- CreateIndex
CREATE UNIQUE INDEX "offer_letter_templates_tenantId_key_version_key" ON "offer_letter_templates"("tenantId", "key", "version");

-- CreateIndex
CREATE INDEX "offer_letter_versions_tenantId_idx" ON "offer_letter_versions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "offer_letter_versions_offerId_version_key" ON "offer_letter_versions"("offerId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "offer_letter_versions_esignProvider_esignEnvelopeId_key" ON "offer_letter_versions"("esignProvider", "esignEnvelopeId");

-- CreateIndex
CREATE INDEX "esign_webhook_events_tenantId_idx" ON "esign_webhook_events"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "esign_webhook_events_provider_providerEventId_key" ON "esign_webhook_events"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "interviews_calendarSyncStatus_calendarNextAttemptAt_idx" ON "interviews"("calendarSyncStatus", "calendarNextAttemptAt");

-- CreateIndex
CREATE INDEX "interviews_status_scheduledAt_idx" ON "interviews"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "offers_status_expiryDate_idx" ON "offers"("status", "expiryDate");

-- AddForeignKey
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "interview_slot_offers_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_reminders" ADD CONSTRAINT "interview_reminders_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_letter_versions" ADD CONSTRAINT "offer_letter_versions_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Closed vocabularies (checked here, mirrored in the lib constants) ──────
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_calendarSyncAction_check"
    CHECK ("calendarSyncAction" IS NULL OR "calendarSyncAction" IN ('CREATE', 'UPDATE', 'CANCEL'));
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_calendarSyncAttempts_check"
    CHECK ("calendarSyncAttempts" >= 0);

ALTER TABLE "offers" ADD CONSTRAINT "offers_declineReasonCode_check"
    CHECK ("declineReasonCode" IS NULL OR "declineReasonCode" IN
        ('ACCEPTED_OTHER_OFFER', 'COMPENSATION', 'LOCATION', 'ROLE_FIT', 'TIMING',
         'COUNTER_OFFER', 'PERSONAL', 'NO_RESPONSE', 'OTHER'));
ALTER TABLE "offers" ADD CONSTRAINT "offers_declineNote_length_check"
    CHECK ("declineNote" IS NULL OR char_length("declineNote") <= 1000);
ALTER TABLE "offers" ADD CONSTRAINT "offers_expiryExtendedCount_check"
    CHECK ("expiryExtendedCount" >= 0);

ALTER TABLE "tenant_recruitment_settings" ADD CONSTRAINT "tenant_recruitment_settings_p3a_ranges_check"
    CHECK ("slotOfferValidityHours" BETWEEN 1 AND 720
       AND "feedbackNudgeHours" BETWEEN 0 AND 168
       AND "feedbackEscalationHours" BETWEEN 1 AND 720
       AND "offerReminderDays" BETWEEN 0 AND 30
       AND "workdayStart" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       AND "workdayEnd" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       AND "workdayStart" < "workdayEnd");

ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "interview_slot_offers_status_check"
    CHECK ("status" IN ('PROPOSED', 'SENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED'));
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "interview_slot_offers_duration_check"
    CHECK ("durationMinutes" BETWEEN 15 AND 480);
ALTER TABLE "interview_slot_offers" ADD CONSTRAINT "interview_slot_offers_slots_check"
    CHECK (jsonb_typeof("slots") = 'array' AND jsonb_array_length("slots") BETWEEN 1 AND 10);

ALTER TABLE "interview_reminders" ADD CONSTRAINT "interview_reminders_kind_check"
    CHECK ("kind" IN ('REMINDER_24H', 'REMINDER_1H', 'FEEDBACK_NUDGE', 'FEEDBACK_ESCALATION',
                      'DECISION_PROMPT', 'NO_SHOW_PROMPT'));

ALTER TABLE "offer_letter_templates" ADD CONSTRAINT "offer_letter_templates_version_check"
    CHECK ("version" >= 1);

ALTER TABLE "offer_letter_versions" ADD CONSTRAINT "offer_letter_versions_signature_check"
    CHECK ("signatureStatus" IN ('NONE', 'SENT', 'VIEWED', 'SIGNED', 'DECLINED', 'EXPIRED', 'VOIDED', 'FAILED'));
ALTER TABLE "offer_letter_versions" ADD CONSTRAINT "offer_letter_versions_version_check"
    CHECK ("version" >= 1);

ALTER TABLE "esign_webhook_events" ADD CONSTRAINT "esign_webhook_events_status_check"
    CHECK ("status" IN ('RECEIVED', 'APPLIED', 'IGNORED', 'FAILED'));

-- ── Row-level security (same policy as every recruitment table) ────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON "interview_slot_offers" TO hr_app;
ALTER TABLE "interview_slot_offers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_slot_offers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "interview_slot_offers";
CREATE POLICY tenant_isolation ON "interview_slot_offers"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "interview_reminders" TO hr_app;
ALTER TABLE "interview_reminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_reminders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "interview_reminders";
CREATE POLICY tenant_isolation ON "interview_reminders"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "offer_letter_templates" TO hr_app;
ALTER TABLE "offer_letter_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "offer_letter_templates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "offer_letter_templates";
CREATE POLICY tenant_isolation ON "offer_letter_templates"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "offer_letter_versions" TO hr_app;
ALTER TABLE "offer_letter_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "offer_letter_versions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "offer_letter_versions";
CREATE POLICY tenant_isolation ON "offer_letter_versions"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "esign_webhook_events" TO hr_app;
ALTER TABLE "esign_webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "esign_webhook_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "esign_webhook_events";
CREATE POLICY tenant_isolation ON "esign_webhook_events"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

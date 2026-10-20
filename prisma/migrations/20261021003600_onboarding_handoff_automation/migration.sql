-- Recruitment Phase 4 — hire handoff and onboarding automation.
--
-- * onboarding_provisioning_requests: requests to IT (account, email, device,
--   access, workspace) raised from IT_ACCESS_SETUP / WORKSPACE_EQUIPMENT
--   checklist tasks; FORCE RLS like every Phase 2 to 3 table.
-- * onboarding_sessions: the template key (one session per checklist and key,
--   so the idempotent handoff cannot duplicate) and calendar invite linkage
--   with the same claim protocol as interviews.
-- * onboarding_checklists: the day-one readiness verdict, gaps and last alert.
-- * onboarding_documents: who supplied a document and HR's review of a new
--   hire's upload.
-- * onboarding_surveys: issue, due and reminder times for the 30/60/90 job.
-- * onboarding_checklist_templates.sessions and the readiness lead days knob.

-- AlterTable
ALTER TABLE "onboarding_checklist_templates" ADD COLUMN     "sessions" JSONB;

-- AlterTable
ALTER TABLE "onboarding_checklists" ADD COLUMN     "readinessAlertedAt" TIMESTAMP(3),
ADD COLUMN     "readinessCheckedAt" TIMESTAMP(3),
ADD COLUMN     "readinessGaps" JSONB,
ADD COLUMN     "readinessStatus" TEXT;

-- AlterTable
ALTER TABLE "onboarding_sessions" ADD COLUMN     "calendarClaimExpiresAt" TIMESTAMP(3),
ADD COLUMN     "calendarClaimedBy" TEXT,
ADD COLUMN     "calendarEventId" TEXT,
ADD COLUMN     "calendarLastError" TEXT,
ADD COLUMN     "calendarNextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "calendarProvider" TEXT,
ADD COLUMN     "calendarSyncAction" TEXT,
ADD COLUMN     "calendarSyncAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "calendarSyncStatus" TEXT,
ADD COLUMN     "calendarSyncedAt" TIMESTAMP(3),
ADD COLUMN     "required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "templateKey" TEXT;

-- AlterTable
ALTER TABLE "onboarding_documents" ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewStatus" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" INTEGER,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'HR';

-- AlterTable
ALTER TABLE "onboarding_surveys" ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "issuedAt" TIMESTAMP(3),
ADD COLUMN     "remindedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tenant_recruitment_settings" ADD COLUMN     "onboardingReadinessLeadDays" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "onboarding_provisioning_requests" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "checklistId" INTEGER NOT NULL,
    "taskId" INTEGER,
    "employeeId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "dueDate" TIMESTAMP(3),
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledById" INTEGER,
    "externalRef" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_provisioning_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_provisioning_requests_taskId_key" ON "onboarding_provisioning_requests"("taskId");

-- CreateIndex
CREATE INDEX "onboarding_provisioning_requests_tenantId_status_idx" ON "onboarding_provisioning_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "onboarding_provisioning_requests_tenantId_dueDate_idx" ON "onboarding_provisioning_requests"("tenantId", "dueDate");

-- CreateIndex
CREATE INDEX "onboarding_provisioning_requests_checklistId_idx" ON "onboarding_provisioning_requests"("checklistId");

-- CreateIndex
CREATE INDEX "onboarding_sessions_calendarSyncStatus_calendarNextAttemptA_idx" ON "onboarding_sessions"("calendarSyncStatus", "calendarNextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_sessions_checklistId_templateKey_key" ON "onboarding_sessions"("checklistId", "templateKey");

-- AddForeignKey
ALTER TABLE "onboarding_provisioning_requests" ADD CONSTRAINT "onboarding_provisioning_requests_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "onboarding_checklists"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Closed vocabularies (mirrored in the lib constants) ────────────────────
ALTER TABLE "onboarding_provisioning_requests" ADD CONSTRAINT "onboarding_provisioning_requests_kind_check"
    CHECK ("kind" IN ('ACCOUNT', 'EMAIL', 'DEVICE', 'ACCESS', 'WORKSPACE', 'OTHER'));
ALTER TABLE "onboarding_provisioning_requests" ADD CONSTRAINT "onboarding_provisioning_requests_status_check"
    CHECK ("status" IN ('REQUESTED', 'IN_PROGRESS', 'FULFILLED', 'REJECTED', 'CANCELLED'));
ALTER TABLE "onboarding_provisioning_requests" ADD CONSTRAINT "onboarding_provisioning_requests_version_check"
    CHECK ("version" >= 0);
ALTER TABLE "onboarding_provisioning_requests" ADD CONSTRAINT "onboarding_provisioning_requests_text_check"
    CHECK (char_length("title") BETWEEN 1 AND 200
       AND ("notes" IS NULL OR char_length("notes") <= 2000)
       AND ("externalRef" IS NULL OR char_length("externalRef") <= 200));
ALTER TABLE "onboarding_sessions" ADD CONSTRAINT "onboarding_sessions_calendar_sync_check"
    CHECK (("calendarSyncStatus" IS NULL OR "calendarSyncStatus" IN ('PENDING', 'SYNCED', 'FAILED'))
       AND ("calendarSyncAction" IS NULL OR "calendarSyncAction" IN ('CREATE', 'UPDATE', 'CANCEL'))
       AND "calendarSyncAttempts" >= 0);
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_readiness_status_check"
    CHECK ("readinessStatus" IS NULL OR "readinessStatus" IN ('READY', 'AT_RISK'));
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_source_check"
    CHECK ("source" IN ('HR', 'NEW_HIRE'));
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_review_check"
    CHECK (("reviewStatus" IS NULL OR "reviewStatus" IN ('PENDING', 'VERIFIED', 'REJECTED'))
       AND ("reviewNote" IS NULL OR char_length("reviewNote") <= 1000));
ALTER TABLE "tenant_recruitment_settings" ADD CONSTRAINT "tenant_recruitment_settings_onboarding_lead_check"
    CHECK ("onboardingReadinessLeadDays" BETWEEN 0 AND 14);

-- ── Tenant isolation (FORCE RLS; the app role, never the owner, reads it) ──
GRANT SELECT, INSERT, UPDATE, DELETE ON "onboarding_provisioning_requests" TO hr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;
ALTER TABLE "onboarding_provisioning_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "onboarding_provisioning_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "onboarding_provisioning_requests";
CREATE POLICY tenant_isolation ON "onboarding_provisioning_requests"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

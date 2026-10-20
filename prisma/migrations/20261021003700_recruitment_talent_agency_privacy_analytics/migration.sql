-- Recruitment Phase 5 — talent pool nurture, internal board and referrals,
-- agencies, privacy operations and analytics alerts.
--
-- * talent_pool_nurture_runs: one proposal per posted requisition, approved
--   by a recruiter before any invitation goes out.
-- * internal_referrals; Application.applicantEmployeeId for internal
--   applicants.
-- * recruitment_agencies, recruitment_agency_users,
--   requisition_agency_assignments, agency_submissions; the owning agency and
--   its window on Candidate and Application.
-- * candidate_retention_runs: dry-run reports and apply runs; the per-tenant
--   apply switch, its sign-off and the data-policy owner on settings.
-- * candidate_data_access_requests: portal intake, verification, access
--   export and SLA alert columns.
-- * recruitment_alerts and the thresholds / recipient on settings.
-- Every new table is tenant-scoped with FORCE RLS.

-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "ownerAgencyId" INTEGER,
ADD COLUMN     "ownershipExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "applicantEmployeeId" INTEGER,
ADD COLUMN     "ownerAgencyId" INTEGER,
ADD COLUMN     "ownershipExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "candidate_data_access_requests" ADD COLUMN     "exportGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "exportMediaId" INTEGER,
ADD COLUMN     "slaAlertedAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'HR',
ADD COLUMN     "verificationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "verificationTokenHash" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "talent_pool_invitations" ADD COLUMN     "nurtureRunId" INTEGER;

-- AlterTable
ALTER TABLE "tenant_recruitment_settings" ADD COLUMN     "alertRecipientId" INTEGER,
ADD COLUMN     "alertThresholds" JSONB,
ADD COLUMN     "dataPolicyOwnerId" INTEGER,
ADD COLUMN     "referralBonusWaitDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "retentionApplyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "retentionApplyEnabledAt" TIMESTAMP(3),
ADD COLUMN     "retentionApplyEnabledById" INTEGER,
ADD COLUMN     "retentionSignoffRunId" INTEGER;

-- CreateTable
CREATE TABLE "talent_pool_nurture_runs" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "criteria" JSONB,
    "candidateIds" JSONB,
    "proposedCount" INTEGER NOT NULL DEFAULT 0,
    "invitedCount" INTEGER NOT NULL DEFAULT 0,
    "validityDays" INTEGER NOT NULL DEFAULT 30,
    "decidedById" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "dismissedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "talent_pool_nurture_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_referrals" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "referrerEmployeeId" INTEGER NOT NULL,
    "candidateId" INTEGER,
    "applicationId" INTEGER,
    "relationship" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "hiredAt" TIMESTAMP(3),
    "bonusStatus" TEXT NOT NULL DEFAULT 'NOT_ELIGIBLE',
    "bonusEligibleAt" TIMESTAMP(3),
    "bonusAmount" DECIMAL(18,2),
    "bonusCurrency" TEXT,
    "bonusDecidedById" INTEGER,
    "bonusDecidedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_agencies" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ownershipDays" INTEGER NOT NULL DEFAULT 180,
    "feePercent" DECIMAL(5,2),
    "notes" TEXT,
    "createdById" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_agencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_agency_users" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "agencyId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_agency_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisition_agency_assignments" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "agencyId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "maxSubmissions" INTEGER,
    "notes" TEXT,
    "assignedById" INTEGER,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requisition_agency_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agency_submissions" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "agencyId" INTEGER NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "candidateId" INTEGER,
    "applicationId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "candidateSnapshot" JSONB NOT NULL,
    "note" TEXT,
    "reviewedById" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "ownershipExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_retention_runs" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "asOf" TIMESTAMP(3) NOT NULL,
    "wouldAnonymize" INTEGER NOT NULL DEFAULT 0,
    "anonymized" INTEGER NOT NULL DEFAULT 0,
    "suspendedByLegalHold" INTEGER NOT NULL DEFAULT 0,
    "candidateIds" JSONB,
    "error" TEXT,
    "reportSentAt" TIMESTAMP(3),
    "signedOffById" INTEGER,
    "signedOffAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_retention_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_alerts" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,
    "threshold" DECIMAL(18,4) NOT NULL,
    "details" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedById" INTEGER,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "recruitment_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "talent_pool_nurture_runs_tenantId_status_idx" ON "talent_pool_nurture_runs"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "talent_pool_nurture_runs_requisitionId_key" ON "talent_pool_nurture_runs"("requisitionId");

-- CreateIndex
CREATE INDEX "internal_referrals_tenantId_status_idx" ON "internal_referrals"("tenantId", "status");

-- CreateIndex
CREATE INDEX "internal_referrals_tenantId_referrerEmployeeId_idx" ON "internal_referrals"("tenantId", "referrerEmployeeId");

-- CreateIndex
CREATE INDEX "internal_referrals_tenantId_bonusStatus_idx" ON "internal_referrals"("tenantId", "bonusStatus");

-- CreateIndex
CREATE INDEX "internal_referrals_applicationId_idx" ON "internal_referrals"("applicationId");

-- CreateIndex
CREATE INDEX "recruitment_agencies_tenantId_status_idx" ON "recruitment_agencies"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_agencies_tenantId_name_key" ON "recruitment_agencies"("tenantId", "name");

-- CreateIndex
CREATE INDEX "recruitment_agency_users_agencyId_idx" ON "recruitment_agency_users"("agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_agency_users_tenantId_userId_key" ON "recruitment_agency_users"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "requisition_agency_assignments_tenantId_agencyId_status_idx" ON "requisition_agency_assignments"("tenantId", "agencyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "requisition_agency_assignments_requisitionId_agencyId_key" ON "requisition_agency_assignments"("requisitionId", "agencyId");

-- CreateIndex
CREATE INDEX "agency_submissions_tenantId_agencyId_status_idx" ON "agency_submissions"("tenantId", "agencyId", "status");

-- CreateIndex
CREATE INDEX "agency_submissions_tenantId_requisitionId_status_idx" ON "agency_submissions"("tenantId", "requisitionId", "status");

-- CreateIndex
CREATE INDEX "candidate_retention_runs_tenantId_createdAt_idx" ON "candidate_retention_runs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "recruitment_alerts_tenantId_status_idx" ON "recruitment_alerts"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_alerts_tenantId_metric_periodStart_key" ON "recruitment_alerts"("tenantId", "metric", "periodStart");

-- CreateIndex
CREATE INDEX "Candidate_tenantId_ownerAgencyId_idx" ON "Candidate"("tenantId", "ownerAgencyId");

-- CreateIndex
CREATE INDEX "Application_ownerAgencyId_idx" ON "Application"("ownerAgencyId");

-- AddForeignKey
ALTER TABLE "recruitment_agency_users" ADD CONSTRAINT "recruitment_agency_users_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "recruitment_agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_agency_assignments" ADD CONSTRAINT "requisition_agency_assignments_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "recruitment_agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_submissions" ADD CONSTRAINT "agency_submissions_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "recruitment_agencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Closed vocabularies (mirrored in the lib constants) ────────────────────
ALTER TABLE "talent_pool_nurture_runs" ADD CONSTRAINT "talent_pool_nurture_runs_status_check"
    CHECK ("status" IN ('PROPOSED', 'SENT', 'DISMISSED', 'EXPIRED')
       AND "proposedCount" >= 0 AND "invitedCount" >= 0 AND "validityDays" BETWEEN 1 AND 365);
ALTER TABLE "internal_referrals" ADD CONSTRAINT "internal_referrals_status_check"
    CHECK ("status" IN ('SUBMITTED', 'IN_PROCESS', 'HIRED', 'REJECTED', 'WITHDRAWN', 'DUPLICATE')
       AND "bonusStatus" IN ('NOT_ELIGIBLE', 'PENDING', 'ELIGIBLE', 'APPROVED', 'PAID', 'FORFEITED')
       AND ("bonusAmount" IS NULL OR "bonusAmount" >= 0)
       AND ("note" IS NULL OR char_length("note") <= 2000)
       AND "version" >= 0);
ALTER TABLE "recruitment_agencies" ADD CONSTRAINT "recruitment_agencies_check"
    CHECK ("status" IN ('ACTIVE', 'SUSPENDED')
       AND char_length("name") BETWEEN 1 AND 200
       AND "ownershipDays" BETWEEN 0 AND 730
       AND ("feePercent" IS NULL OR ("feePercent" >= 0 AND "feePercent" <= 100))
       AND "version" >= 0);
ALTER TABLE "recruitment_agency_users" ADD CONSTRAINT "recruitment_agency_users_status_check"
    CHECK ("status" IN ('ACTIVE', 'REVOKED'));
ALTER TABLE "requisition_agency_assignments" ADD CONSTRAINT "requisition_agency_assignments_check"
    CHECK ("status" IN ('ACTIVE', 'ENDED') AND ("maxSubmissions" IS NULL OR "maxSubmissions" > 0));
ALTER TABLE "agency_submissions" ADD CONSTRAINT "agency_submissions_status_check"
    CHECK ("status" IN ('PENDING_REVIEW', 'ACCEPTED', 'REJECTED', 'DUPLICATE', 'WITHDRAWN')
       AND ("rejectionReason" IS NULL OR char_length("rejectionReason") <= 1000));
ALTER TABLE "candidate_retention_runs" ADD CONSTRAINT "candidate_retention_runs_check"
    CHECK ("mode" IN ('DRY_RUN', 'APPLY') AND "status" IN ('COMPLETED', 'FAILED')
       AND "wouldAnonymize" >= 0 AND "anonymized" >= 0 AND "suspendedByLegalHold" >= 0);
ALTER TABLE "recruitment_alerts" ADD CONSTRAINT "recruitment_alerts_check"
    CHECK ("metric" IN ('TIME_TO_FILL', 'SLA_BREACHES', 'OFFER_DECLINE_RATE', 'FAILED_HANDOFFS')
       AND "status" IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED'));
ALTER TABLE "candidate_data_access_requests" ADD CONSTRAINT "candidate_data_access_requests_source_check"
    CHECK ("source" IN ('HR', 'PORTAL'));
ALTER TABLE "tenant_recruitment_settings" ADD CONSTRAINT "tenant_recruitment_settings_phase5_check"
    CHECK ("referralBonusWaitDays" BETWEEN 0 AND 730);

-- ── Tenant isolation (FORCE RLS; the app role, never the owner, reads it) ──
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "talent_pool_nurture_runs" TO hr_app;
ALTER TABLE "talent_pool_nurture_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "talent_pool_nurture_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "talent_pool_nurture_runs";
CREATE POLICY tenant_isolation ON "talent_pool_nurture_runs"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "internal_referrals" TO hr_app;
ALTER TABLE "internal_referrals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "internal_referrals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "internal_referrals";
CREATE POLICY tenant_isolation ON "internal_referrals"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "recruitment_agencies" TO hr_app;
ALTER TABLE "recruitment_agencies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment_agencies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "recruitment_agencies";
CREATE POLICY tenant_isolation ON "recruitment_agencies"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "recruitment_agency_users" TO hr_app;
ALTER TABLE "recruitment_agency_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment_agency_users" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "recruitment_agency_users";
CREATE POLICY tenant_isolation ON "recruitment_agency_users"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "requisition_agency_assignments" TO hr_app;
ALTER TABLE "requisition_agency_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "requisition_agency_assignments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "requisition_agency_assignments";
CREATE POLICY tenant_isolation ON "requisition_agency_assignments"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "agency_submissions" TO hr_app;
ALTER TABLE "agency_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agency_submissions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "agency_submissions";
CREATE POLICY tenant_isolation ON "agency_submissions"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_retention_runs" TO hr_app;
ALTER TABLE "candidate_retention_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_retention_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_retention_runs";
CREATE POLICY tenant_isolation ON "candidate_retention_runs"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "recruitment_alerts" TO hr_app;
ALTER TABLE "recruitment_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment_alerts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "recruitment_alerts";
CREATE POLICY tenant_isolation ON "recruitment_alerts"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');


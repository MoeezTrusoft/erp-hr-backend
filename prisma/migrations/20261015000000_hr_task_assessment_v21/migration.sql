-- CreateTable
CREATE TABLE "AssessmentIdentity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "employeeRowId" INTEGER NOT NULL,
    "managerCode" TEXT,
    "departmentRef" TEXT,
    "positionRef" TEXT,
    "categoryCode" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentCategory" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AssessmentCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentTaskVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "taskCode" TEXT NOT NULL,
    "taskVersion" INTEGER NOT NULL,
    "familyCode" TEXT NOT NULL,
    "sectionCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "ownerCode" TEXT NOT NULL,
    "createdByCode" TEXT NOT NULL,
    "approvedByCode" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "AssessmentTaskVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentProfileVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "profileCode" TEXT NOT NULL,
    "profileVersion" INTEGER NOT NULL,
    "departmentRef" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "positionRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "guideRef" TEXT,
    "impactComparison" JSONB,
    "ownerCode" TEXT NOT NULL,
    "createdByCode" TEXT NOT NULL,
    "subjectReviewedByCode" TEXT,
    "approvedByCode" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "AssessmentProfileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentProfileTask" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "profileRef" UUID NOT NULL,
    "taskRef" UUID NOT NULL,
    "taskCode" TEXT NOT NULL,
    "requirement" JSONB NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "AssessmentProfileTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentGuideVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "profileRef" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentGuideVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeAssessmentProfile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "profileRef" UUID NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "approvedByCode" TEXT NOT NULL,
    "sourceEventRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "EmployeeAssessmentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentQualification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "familyCode" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "calibration" JSONB NOT NULL,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "authorizedByCode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAssessments" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AssessmentQualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentConfiguration" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "policy" JSONB NOT NULL,
    "sourceRegister" JSONB NOT NULL DEFAULT '[]',
    "departments" JSONB NOT NULL DEFAULT '[]',
    "learningMappings" JSONB NOT NULL DEFAULT '[]',
    "translations" JSONB NOT NULL DEFAULT '{}',
    "rolloutEvidence" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByCode" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentTriggerPolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "triggerType" TEXT NOT NULL,
    "scopeFilter" JSONB NOT NULL,
    "policy" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AssessmentTriggerPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentAssignment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "profileRef" UUID NOT NULL,
    "profileSnapshot" JSONB NOT NULL,
    "policySnapshot" JSONB NOT NULL,
    "purpose" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "raterCode" TEXT NOT NULL,
    "reviewerCode" TEXT NOT NULL,
    "taskCodes" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "revisionNo" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "triggerRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "holdUntil" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "stageStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentRevision" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assessmentRef" UUID NOT NULL,
    "revisionNo" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "checksDigest" TEXT NOT NULL,
    "reviewTier" TEXT NOT NULL,
    "sampled" BOOLEAN NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "sequence" INTEGER,

    CONSTRAINT "AssessmentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentObservation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assessmentRef" UUID NOT NULL,
    "revisionNo" INTEGER NOT NULL,
    "taskCode" TEXT NOT NULL,
    "taskVersion" INTEGER NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "qualityStatus" TEXT NOT NULL,
    "criticalFailure" BOOLEAN NOT NULL DEFAULT false,
    "criticalExceptionReason" TEXT,
    "observationNote" TEXT NOT NULL,
    "evidenceBriefDigest" TEXT NOT NULL,
    "draftedNote" JSONB,
    "timingRefs" JSONB NOT NULL DEFAULT '[]',
    "velocityInput" JSONB,
    "durationSeconds" INTEGER,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assessorCode" TEXT NOT NULL,

    CONSTRAINT "AssessmentObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentDimension" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "observationRef" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "score" INTEGER,
    "reasonCode" TEXT,
    "rationale" TEXT,
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "behaviorCheck" JSONB,
    "calculation" JSONB,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AssessmentDimension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentCase" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "origin" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "taskCodes" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "createdByCode" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,

    CONSTRAINT "AssessmentCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentEvidence" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseRef" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "taskCodes" JSONB NOT NULL,
    "dimensions" JSONB NOT NULL,
    "attribution" JSONB NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "executionVerified" BOOLEAN NOT NULL,
    "substantive" BOOLEAN NOT NULL,
    "nonroutine" BOOLEAN NOT NULL,
    "qualityStatus" TEXT NOT NULL,
    "integrityFlags" JSONB NOT NULL DEFAULT '[]',
    "scanState" TEXT NOT NULL,
    "captureAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "retentionUntil" TIMESTAMP(3) NOT NULL,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AssessmentEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentEvidenceLink" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assessmentRef" UUID NOT NULL,
    "revisionNo" INTEGER NOT NULL,
    "taskCode" TEXT NOT NULL,
    "evidenceRef" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "contributionConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "acceptanceConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "behaviorCheck" TEXT,
    "confirmedByCode" TEXT NOT NULL,

    CONSTRAINT "AssessmentEvidenceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentTimingSample" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "evidenceRef" UUID NOT NULL,
    "caseRef" UUID NOT NULL,
    "taskCode" TEXT NOT NULL,
    "taskVersion" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "clockBasis" TEXT NOT NULL,
    "complexity" TEXT NOT NULL,
    "technology" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "attributableMinutes" DECIMAL(18,6) NOT NULL,
    "elapsedMinutes" DECIMAL(18,6) NOT NULL,
    "waitMinutes" DECIMAL(18,6) NOT NULL,
    "acceptedUnits" DECIMAL(18,6) NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "comparable" BOOLEAN NOT NULL,
    "attempts" INTEGER NOT NULL,
    "reworkMinutes" DECIMAL(18,6) NOT NULL,
    "input" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "AssessmentTimingSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentBenchmark" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "taskCode" TEXT NOT NULL,
    "taskVersion" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "clockBasis" TEXT NOT NULL,
    "complexity" TEXT NOT NULL,
    "technology" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "minutesPerUnit" DECIMAL(18,6) NOT NULL,
    "provenance" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "ownerCode" TEXT NOT NULL,
    "approvedByCode" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "reviewAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentBenchmark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentSignOff" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assessmentRef" UUID NOT NULL,
    "revisionNo" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "actorPrincipal" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "attestation" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentSignOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentRestriction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "taskCode" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" TIMESTAMP(3),
    "liftedByCode" TEXT,
    "restorationRef" TEXT,

    CONSTRAINT "AssessmentRestriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentCapability" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "taskCode" TEXT NOT NULL,
    "taskVersion" INTEGER NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "score" INTEGER,
    "revisionRef" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentAudit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "aggregateRef" TEXT NOT NULL,
    "actorPrincipal" TEXT NOT NULL,
    "actorCode" TEXT,
    "action" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "resultDigest" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentAutomationRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runKey" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentAutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentException" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ownerRole" TEXT NOT NULL,
    "scopeRef" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "stableSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AssessmentException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentInboxEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AssessmentInboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentIntegration" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "targetRef" TEXT,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentAppraisalInput" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "cycleId" INTEGER NOT NULL,
    "revisionRef" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "amendment" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentAppraisalInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentCodeChange" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "oldCode" TEXT NOT NULL,
    "newCode" TEXT NOT NULL,
    "approvedByCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "propagationState" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "AssessmentCodeChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentNotification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" VARCHAR(50) NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "assessmentRef" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,

    CONSTRAINT "AssessmentNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentIdentity_tenantId_employeeCode_key" ON "AssessmentIdentity"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentIdentity_tenantId_employeeRowId_key" ON "AssessmentIdentity"("tenantId", "employeeRowId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentCategory_tenantId_categoryCode_key" ON "AssessmentCategory"("tenantId", "categoryCode");

-- CreateIndex
CREATE INDEX "AssessmentTaskVersion_tenantId_familyCode_status_idx" ON "AssessmentTaskVersion"("tenantId", "familyCode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentTaskVersion_tenantId_taskCode_taskVersion_key" ON "AssessmentTaskVersion"("tenantId", "taskCode", "taskVersion");

-- CreateIndex
CREATE INDEX "AssessmentProfileVersion_tenantId_departmentRef_categoryCod_idx" ON "AssessmentProfileVersion"("tenantId", "departmentRef", "categoryCode", "positionRef", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentProfileVersion_tenantId_profileCode_profileVersio_key" ON "AssessmentProfileVersion"("tenantId", "profileCode", "profileVersion");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentProfileTask_tenantId_profileRef_taskCode_key" ON "AssessmentProfileTask"("tenantId", "profileRef", "taskCode");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentGuideVersion_tenantId_profileRef_locale_version_key" ON "AssessmentGuideVersion"("tenantId", "profileRef", "locale", "version");

-- CreateIndex
CREATE INDEX "EmployeeAssessmentProfile_tenantId_employeeCode_effectiveFr_idx" ON "EmployeeAssessmentProfile"("tenantId", "employeeCode", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentQualification_tenantId_employeeCode_familyCode_key" ON "AssessmentQualification"("tenantId", "employeeCode", "familyCode");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentConfiguration_tenantId_key" ON "AssessmentConfiguration"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentTriggerPolicy_tenantId_triggerType_key" ON "AssessmentTriggerPolicy"("tenantId", "triggerType");

-- CreateIndex
CREATE INDEX "AssessmentAssignment_tenantId_raterCode_state_dueAt_idx" ON "AssessmentAssignment"("tenantId", "raterCode", "state", "dueAt");

-- CreateIndex
CREATE INDEX "AssessmentAssignment_tenantId_employeeCode_state_idx" ON "AssessmentAssignment"("tenantId", "employeeCode", "state");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentAssignment_tenantId_idempotencyKey_key" ON "AssessmentAssignment"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentRevision_tenantId_assessmentRef_revisionNo_key" ON "AssessmentRevision"("tenantId", "assessmentRef", "revisionNo");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentObservation_tenantId_assessmentRef_revisionNo_tas_key" ON "AssessmentObservation"("tenantId", "assessmentRef", "revisionNo", "taskCode");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentDimension_tenantId_observationRef_dimension_key" ON "AssessmentDimension"("tenantId", "observationRef", "dimension");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentCase_tenantId_idempotencyKey_key" ON "AssessmentCase"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AssessmentEvidence_tenantId_employeeCode_captureAt_idx" ON "AssessmentEvidence"("tenantId", "employeeCode", "captureAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentEvidence_tenantId_source_sourceRecordId_sourceVer_key" ON "AssessmentEvidence"("tenantId", "source", "sourceRecordId", "sourceVersion", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentEvidenceLink_tenantId_assessmentRef_revisionNo_ta_key" ON "AssessmentEvidenceLink"("tenantId", "assessmentRef", "revisionNo", "taskCode", "evidenceRef");

-- CreateIndex
CREATE INDEX "AssessmentTimingSample_tenantId_taskCode_taskVersion_captur_idx" ON "AssessmentTimingSample"("tenantId", "taskCode", "taskVersion", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentTimingSample_tenantId_evidenceRef_taskCode_key" ON "AssessmentTimingSample"("tenantId", "evidenceRef", "taskCode");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentBenchmark_tenantId_taskCode_taskVersion_scopeKey__key" ON "AssessmentBenchmark"("tenantId", "taskCode", "taskVersion", "scopeKey", "version");

-- CreateIndex
CREATE INDEX "AssessmentSignOff_tenantId_assessmentRef_revisionNo_idx" ON "AssessmentSignOff"("tenantId", "assessmentRef", "revisionNo");

-- CreateIndex
CREATE INDEX "AssessmentRestriction_tenantId_employeeCode_liftedAt_idx" ON "AssessmentRestriction"("tenantId", "employeeCode", "liftedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentRestriction_tenantId_employeeCode_taskCode_cause__key" ON "AssessmentRestriction"("tenantId", "employeeCode", "taskCode", "cause", "sourceRef");

-- CreateIndex
CREATE INDEX "AssessmentCapability_tenantId_expiresAt_idx" ON "AssessmentCapability"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentCapability_tenantId_employeeCode_taskCode_scopeKe_key" ON "AssessmentCapability"("tenantId", "employeeCode", "taskCode", "scopeKey", "dimension");

-- CreateIndex
CREATE INDEX "AssessmentAudit_tenantId_aggregateRef_createdAt_idx" ON "AssessmentAudit"("tenantId", "aggregateRef", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentAutomationRun_tenantId_runKey_key" ON "AssessmentAutomationRun"("tenantId", "runKey");

-- CreateIndex
CREATE INDEX "AssessmentException_tenantId_kind_status_idx" ON "AssessmentException"("tenantId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentException_tenantId_key_key" ON "AssessmentException"("tenantId", "key");

-- CreateIndex
CREATE INDEX "AssessmentInboxEvent_status_nextAttemptAt_idx" ON "AssessmentInboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentInboxEvent_tenantId_eventId_key" ON "AssessmentInboxEvent"("tenantId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentIntegration_tenantId_kind_key_key" ON "AssessmentIntegration"("tenantId", "kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentAppraisalInput_tenantId_employeeCode_cycleId_revi_key" ON "AssessmentAppraisalInput"("tenantId", "employeeCode", "cycleId", "revisionRef");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentCodeChange_tenantId_oldCode_key" ON "AssessmentCodeChange"("tenantId", "oldCode");

-- CreateIndex
CREATE INDEX "AssessmentNotification_tenantId_employeeCode_sentAt_idx" ON "AssessmentNotification"("tenantId", "employeeCode", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentNotification_tenantId_key_key" ON "AssessmentNotification"("tenantId", "key");

-- Assessment defense in depth: tenant isolation and immutable evidence.
ALTER TABLE "AssessmentIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentIdentity" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentIdentity" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentIdentity_tenant_id_guard" ON "AssessmentIdentity" ("tenantId", "id");
ALTER TABLE "AssessmentCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentCategory" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentCategory" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentCategory_tenant_id_guard" ON "AssessmentCategory" ("tenantId", "id");
ALTER TABLE "AssessmentTaskVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentTaskVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentTaskVersion" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentTaskVersion_tenant_id_guard" ON "AssessmentTaskVersion" ("tenantId", "id");
ALTER TABLE "AssessmentProfileVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentProfileVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentProfileVersion" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentProfileVersion_tenant_id_guard" ON "AssessmentProfileVersion" ("tenantId", "id");
ALTER TABLE "AssessmentProfileTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentProfileTask" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentProfileTask" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentProfileTask_tenant_id_guard" ON "AssessmentProfileTask" ("tenantId", "id");
ALTER TABLE "AssessmentGuideVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentGuideVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentGuideVersion" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentGuideVersion_tenant_id_guard" ON "AssessmentGuideVersion" ("tenantId", "id");
ALTER TABLE "EmployeeAssessmentProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeAssessmentProfile" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "EmployeeAssessmentProfile" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "EmployeeAssessmentProfile_tenant_id_guard" ON "EmployeeAssessmentProfile" ("tenantId", "id");
ALTER TABLE "AssessmentQualification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentQualification" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentQualification" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentQualification_tenant_id_guard" ON "AssessmentQualification" ("tenantId", "id");
ALTER TABLE "AssessmentConfiguration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentConfiguration" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentConfiguration" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentConfiguration_tenant_id_guard" ON "AssessmentConfiguration" ("tenantId", "id");
ALTER TABLE "AssessmentTriggerPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentTriggerPolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentTriggerPolicy" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentTriggerPolicy_tenant_id_guard" ON "AssessmentTriggerPolicy" ("tenantId", "id");
ALTER TABLE "AssessmentAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentAssignment" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentAssignment" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentAssignment_tenant_id_guard" ON "AssessmentAssignment" ("tenantId", "id");
ALTER TABLE "AssessmentRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentRevision" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentRevision_tenant_id_guard" ON "AssessmentRevision" ("tenantId", "id");
ALTER TABLE "AssessmentObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentObservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentObservation" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentObservation_tenant_id_guard" ON "AssessmentObservation" ("tenantId", "id");
ALTER TABLE "AssessmentDimension" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentDimension" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentDimension" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentDimension_tenant_id_guard" ON "AssessmentDimension" ("tenantId", "id");
ALTER TABLE "AssessmentCase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentCase" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentCase" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentCase_tenant_id_guard" ON "AssessmentCase" ("tenantId", "id");
ALTER TABLE "AssessmentEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentEvidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentEvidence" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentEvidence_tenant_id_guard" ON "AssessmentEvidence" ("tenantId", "id");
ALTER TABLE "AssessmentEvidenceLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentEvidenceLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentEvidenceLink" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentEvidenceLink_tenant_id_guard" ON "AssessmentEvidenceLink" ("tenantId", "id");
ALTER TABLE "AssessmentTimingSample" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentTimingSample" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentTimingSample" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentTimingSample_tenant_id_guard" ON "AssessmentTimingSample" ("tenantId", "id");
ALTER TABLE "AssessmentBenchmark" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentBenchmark" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentBenchmark" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentBenchmark_tenant_id_guard" ON "AssessmentBenchmark" ("tenantId", "id");
ALTER TABLE "AssessmentSignOff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentSignOff" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentSignOff" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentSignOff_tenant_id_guard" ON "AssessmentSignOff" ("tenantId", "id");
ALTER TABLE "AssessmentRestriction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentRestriction" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentRestriction" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentRestriction_tenant_id_guard" ON "AssessmentRestriction" ("tenantId", "id");
ALTER TABLE "AssessmentCapability" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentCapability" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentCapability" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentCapability_tenant_id_guard" ON "AssessmentCapability" ("tenantId", "id");
ALTER TABLE "AssessmentAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentAudit" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentAudit" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentAudit_tenant_id_guard" ON "AssessmentAudit" ("tenantId", "id");
ALTER TABLE "AssessmentAutomationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentAutomationRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentAutomationRun" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentAutomationRun_tenant_id_guard" ON "AssessmentAutomationRun" ("tenantId", "id");
ALTER TABLE "AssessmentException" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentException" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentException" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentException_tenant_id_guard" ON "AssessmentException" ("tenantId", "id");
ALTER TABLE "AssessmentInboxEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentInboxEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentInboxEvent" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentInboxEvent_tenant_id_guard" ON "AssessmentInboxEvent" ("tenantId", "id");
ALTER TABLE "AssessmentIntegration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentIntegration" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentIntegration" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentIntegration_tenant_id_guard" ON "AssessmentIntegration" ("tenantId", "id");
ALTER TABLE "AssessmentAppraisalInput" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentAppraisalInput" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentAppraisalInput" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentAppraisalInput_tenant_id_guard" ON "AssessmentAppraisalInput" ("tenantId", "id");
ALTER TABLE "AssessmentCodeChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentCodeChange" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentCodeChange" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentCodeChange_tenant_id_guard" ON "AssessmentCodeChange" ("tenantId", "id");
ALTER TABLE "AssessmentNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentNotification" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_tenant ON "AssessmentNotification" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE UNIQUE INDEX "AssessmentNotification_tenant_id_guard" ON "AssessmentNotification" ("tenantId", "id");
ALTER TABLE "AssessmentProfileTask" ADD CONSTRAINT "AssessmentProfileTask_profileRef_tenant_fk" FOREIGN KEY ("tenantId","profileRef") REFERENCES "AssessmentProfileVersion" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentProfileTask" ADD CONSTRAINT "AssessmentProfileTask_taskRef_tenant_fk" FOREIGN KEY ("tenantId","taskRef") REFERENCES "AssessmentTaskVersion" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentGuideVersion" ADD CONSTRAINT "AssessmentGuideVersion_profileRef_tenant_fk" FOREIGN KEY ("tenantId","profileRef") REFERENCES "AssessmentProfileVersion" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "EmployeeAssessmentProfile" ADD CONSTRAINT "EmployeeAssessmentProfile_profileRef_tenant_fk" FOREIGN KEY ("tenantId","profileRef") REFERENCES "AssessmentProfileVersion" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentAssignment" ADD CONSTRAINT "AssessmentAssignment_profileRef_tenant_fk" FOREIGN KEY ("tenantId","profileRef") REFERENCES "AssessmentProfileVersion" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentRevision" ADD CONSTRAINT "AssessmentRevision_assessmentRef_tenant_fk" FOREIGN KEY ("tenantId","assessmentRef") REFERENCES "AssessmentAssignment" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentObservation" ADD CONSTRAINT "AssessmentObservation_assessmentRef_tenant_fk" FOREIGN KEY ("tenantId","assessmentRef") REFERENCES "AssessmentAssignment" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentDimension" ADD CONSTRAINT "AssessmentDimension_observationRef_tenant_fk" FOREIGN KEY ("tenantId","observationRef") REFERENCES "AssessmentObservation" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentEvidence" ADD CONSTRAINT "AssessmentEvidence_caseRef_tenant_fk" FOREIGN KEY ("tenantId","caseRef") REFERENCES "AssessmentCase" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentEvidenceLink" ADD CONSTRAINT "AssessmentEvidenceLink_assessmentRef_tenant_fk" FOREIGN KEY ("tenantId","assessmentRef") REFERENCES "AssessmentAssignment" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentEvidenceLink" ADD CONSTRAINT "AssessmentEvidenceLink_evidenceRef_tenant_fk" FOREIGN KEY ("tenantId","evidenceRef") REFERENCES "AssessmentEvidence" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentTimingSample" ADD CONSTRAINT "AssessmentTimingSample_evidenceRef_tenant_fk" FOREIGN KEY ("tenantId","evidenceRef") REFERENCES "AssessmentEvidence" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentTimingSample" ADD CONSTRAINT "AssessmentTimingSample_caseRef_tenant_fk" FOREIGN KEY ("tenantId","caseRef") REFERENCES "AssessmentCase" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentSignOff" ADD CONSTRAINT "AssessmentSignOff_assessmentRef_tenant_fk" FOREIGN KEY ("tenantId","assessmentRef") REFERENCES "AssessmentAssignment" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentCapability" ADD CONSTRAINT "AssessmentCapability_revisionRef_tenant_fk" FOREIGN KEY ("tenantId","revisionRef") REFERENCES "AssessmentRevision" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "AssessmentAppraisalInput" ADD CONSTRAINT "AssessmentAppraisalInput_revisionRef_tenant_fk" FOREIGN KEY ("tenantId","revisionRef") REFERENCES "AssessmentRevision" ("tenantId","id") ON DELETE RESTRICT;

ALTER TABLE "AssessmentDimension" ADD CONSTRAINT assessment_dimension_valid CHECK (
  "dimension" IN ('K','S','V') AND "status" IN ('RATED','PENDING','NOT_APPLICABLE') AND
  (("status"='RATED' AND "score" IS NOT NULL AND "score" BETWEEN 0 AND 4) OR ("status"<>'RATED' AND "score" IS NULL)));
ALTER TABLE "AssessmentCapability" ADD CONSTRAINT assessment_capability_score CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 4);
ALTER TABLE "AssessmentAssignment" ADD CONSTRAINT assessment_independent_actors CHECK ("employeeCode"<>"raterCode" AND "employeeCode"<>"reviewerCode" AND "raterCode"<>"reviewerCode");
ALTER TABLE "AssessmentIdentity" ADD CONSTRAINT assessment_code_canonical CHECK (length("employeeCode")>0 AND "employeeCode"=btrim("employeeCode"));
ALTER TABLE "AssessmentTimingSample" ADD CONSTRAINT assessment_timing_nonnegative CHECK ("attributableMinutes">=0 AND "acceptedUnits">=0 AND "reworkMinutes">=0 AND "attempts">0);
ALTER TABLE "AssessmentBenchmark" ADD CONSTRAINT assessment_benchmark_positive CHECK ("minutesPerUnit">0);
CREATE FUNCTION assessment_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Assessment audit and signatures are append-only'; END $$;
CREATE TRIGGER assessment_audit_immutable BEFORE UPDATE OR DELETE ON "AssessmentAudit" FOR EACH ROW EXECUTE FUNCTION assessment_append_only();
CREATE TRIGGER assessment_signoff_immutable BEFORE UPDATE OR DELETE ON "AssessmentSignOff" FOR EACH ROW EXECUTE FUNCTION assessment_append_only();
CREATE TRIGGER assessment_guide_immutable BEFORE UPDATE OR DELETE ON "AssessmentGuideVersion" FOR EACH ROW EXECUTE FUNCTION assessment_append_only();
CREATE TRIGGER assessment_appraisal_immutable BEFORE UPDATE OR DELETE ON "AssessmentAppraisalInput" FOR EACH ROW EXECUTE FUNCTION assessment_append_only();
CREATE FUNCTION assessment_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (OLD.status IN ('PUBLISHED','RETIRED') AND (NEW.definition IS DISTINCT FROM OLD.definition OR NEW."ownerCode" IS DISTINCT FROM OLD."ownerCode" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId")) THEN RAISE EXCEPTION 'Published catalogue versions are immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER assessment_task_immutable BEFORE UPDATE OR DELETE ON "AssessmentTaskVersion" FOR EACH ROW EXECUTE FUNCTION assessment_catalog_immutable();
CREATE TRIGGER assessment_profile_immutable BEFORE UPDATE OR DELETE ON "AssessmentProfileVersion" FOR EACH ROW EXECUTE FUNCTION assessment_catalog_immutable();
CREATE FUNCTION assessment_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.digest IS DISTINCT FROM OLD.digest OR NEW."assessmentRef" IS DISTINCT FROM OLD."assessmentRef" OR NEW."revisionNo" IS DISTINCT FROM OLD."revisionNo" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN RAISE EXCEPTION 'Submitted revision content is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER assessment_revision_frozen BEFORE UPDATE OR DELETE ON "AssessmentRevision" FOR EACH ROW EXECUTE FUNCTION assessment_revision_immutable();
CREATE FUNCTION assessment_observation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a RECORD; BEGIN
 SELECT * INTO a FROM "AssessmentAssignment" WHERE id=OLD."assessmentRef" AND "tenantId"=OLD."tenantId";
 IF a.state NOT IN ('ASSIGNED','IN_PROGRESS','RETURNED') OR a."revisionNo"<>OLD."revisionNo" THEN RAISE EXCEPTION 'Submitted observation is frozen'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
CREATE TRIGGER assessment_observation_frozen BEFORE UPDATE OR DELETE ON "AssessmentObservation" FOR EACH ROW EXECUTE FUNCTION assessment_observation_frozen();
CREATE FUNCTION assessment_dimension_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE current_assignment RECORD; BEGIN
 SELECT a.* INTO current_assignment FROM "AssessmentAssignment" a JOIN "AssessmentObservation" o ON o."assessmentRef"=a.id AND o."tenantId"=a."tenantId" WHERE o.id=OLD."observationRef" AND o."tenantId"=OLD."tenantId" AND o."revisionNo"=a."revisionNo";
 IF current_assignment.id IS NULL OR current_assignment.state NOT IN ('ASSIGNED','IN_PROGRESS','RETURNED') THEN RAISE EXCEPTION 'Submitted dimension is frozen'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
CREATE TRIGGER assessment_dimension_frozen BEFORE UPDATE OR DELETE ON "AssessmentDimension" FOR EACH ROW EXECUTE FUNCTION assessment_dimension_frozen();
CREATE FUNCTION assessment_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash" OR NEW."sourceVersion" IS DISTINCT FROM OLD."sourceVersion" OR NEW."employeeCode" IS DISTINCT FROM OLD."employeeCode" OR NEW."caseRef" IS DISTINCT FROM OLD."caseRef" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN RAISE EXCEPTION 'Evidence versions cannot be rewritten'; END IF; RETURN NEW; END $$;
CREATE TRIGGER assessment_evidence_immutable BEFORE UPDATE OR DELETE ON "AssessmentEvidence" FOR EACH ROW EXECUTE FUNCTION assessment_evidence_immutable();
CREATE FUNCTION assessment_employee_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.employee_code IS DISTINCT FROM OLD.employee_code AND EXISTS(SELECT 1 FROM "AssessmentIdentity" WHERE "employeeRowId"=OLD.id AND "tenantId"=OLD.tenant_id) AND NOT EXISTS(SELECT 1 FROM "AssessmentCodeChange" WHERE id::text=current_setting('app.assessment_code_change',true) AND "tenantId"=OLD.tenant_id AND "oldCode"=OLD.employee_code AND "newCode"=NEW.employee_code) THEN RAISE EXCEPTION 'Use the approved employee-code correction workflow'; END IF; RETURN NEW; END $$;
CREATE TRIGGER assessment_employee_code_guard BEFORE UPDATE OF employee_code ON "Employee" FOR EACH ROW EXECUTE FUNCTION assessment_employee_code_guard();

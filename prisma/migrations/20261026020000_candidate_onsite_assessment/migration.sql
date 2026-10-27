-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "interviewerTrainedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "interviews" ADD COLUMN     "assessmentRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "assessmentStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "formSnapshot" JSONB,
ADD COLUMN     "formTemplateId" INTEGER,
ADD COLUMN     "formTemplateVersion" INTEGER;

-- AlterTable
ALTER TABLE "interview_interviewers" ADD COLUMN     "panelRole" TEXT;

-- AlterTable
ALTER TABLE "interview_scorecards" ADD COLUMN     "coiDeclared" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "criterionScores" JSONB,
ADD COLUMN     "draftSavedAt" TIMESTAMP(3),
ADD COLUMN     "mustHaveFailed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewFlags" TEXT[],
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "templateVersion" INTEGER,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "weightedScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "scorecard_templates" ADD COLUMN     "interviewType" TEXT,
ADD COLUMN     "panelRole" TEXT,
ADD COLUMN     "requiresTraining" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sections" JSONB,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "CandidateTestItem" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "itemCode" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "type" TEXT NOT NULL,
    "stem" TEXT NOT NULL,
    "mediaId" TEXT,
    "options" JSONB NOT NULL,
    "answerKey" TEXT NOT NULL,
    "scoringRule" TEXT NOT NULL DEFAULT 'EXACT',
    "difficulty" TEXT NOT NULL,
    "competencyKey" TEXT NOT NULL,
    "skillId" INTEGER NOT NULL,
    "jobFamily" TEXT NOT NULL,
    "gradeLevelIds" INTEGER[],
    "language" TEXT NOT NULL DEFAULT 'EN',
    "timeEstimateSec" INTEGER NOT NULL DEFAULT 60,
    "rationale" TEXT NOT NULL,
    "authorId" INTEGER NOT NULL,
    "reviewerId" INTEGER,
    "reviewComment" TEXT,
    "exposureCount" INTEGER NOT NULL DEFAULT 0,
    "exposureCap" INTEGER NOT NULL DEFAULT 100,
    "discussionPrompt" BOOLEAN NOT NULL DEFAULT false,
    "aiDrafted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateTestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTestItemStat" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "itemId" INTEGER NOT NULL,
    "period" DATE NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "difficulty" DOUBLE PRECISION,
    "discrimination" DOUBLE PRECISION,
    "distractorRates" JSONB NOT NULL,
    "avgTimeSec" DOUBLE PRECISION,
    "flags" TEXT[],

    CONSTRAINT "CandidateTestItemStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTestBlueprint" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "jobFamily" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'EN',
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "passMarkPct" DOUBLE PRECISION NOT NULL DEFAULT 60,
    "borderlineBandPct" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "hardFloorPct" DOUBLE PRECISION,
    "negativeMarking" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sections" JSONB NOT NULL,
    "navigation" TEXT NOT NULL DEFAULT 'BACK_ALLOWED',
    "retakeCooldownDays" INTEGER NOT NULL DEFAULT 180,
    "resultValidityDays" INTEGER NOT NULL DEFAULT 90,
    "testWeightPct" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "integrityThreshold" INTEGER NOT NULL DEFAULT 3,
    "createdById" INTEGER NOT NULL,
    "approvedByHiringManagerId" INTEGER,
    "approvedByHrId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateTestBlueprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTestBlueprintLink" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "blueprintId" INTEGER NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CandidateTestBlueprintLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestWorkstation" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "label" TEXT NOT NULL,
    "siteRef" TEXT NOT NULL,
    "deviceTokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastSeenAt" TIMESTAMP(3),
    "registeredById" INTEGER NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "TestWorkstation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateCheckIn" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "interviewId" INTEGER NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "idType" TEXT NOT NULL,
    "idLast4" TEXT NOT NULL,
    "verifiedById" INTEGER NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "photoMediaId" TEXT,
    "photoConsentAt" TIMESTAMP(3),
    "accommodationReason" TEXT,

    CONSTRAINT "CandidateCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTestSession" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "applicationId" INTEGER NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "interviewId" INTEGER NOT NULL,
    "blueprintId" INTEGER NOT NULL,
    "blueprintVersion" INTEGER NOT NULL,
    "blueprintSnapshot" JSONB NOT NULL,
    "workstationId" INTEGER NOT NULL,
    "sessionCodeHash" TEXT,
    "accessTokenHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "codeExpiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "extraTimePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "itemOrder" JSONB NOT NULL,
    "currentIndex" INTEGER NOT NULL DEFAULT 0,
    "lastHeartbeatAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "issuedById" INTEGER NOT NULL,

    CONSTRAINT "CandidateTestSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTestResponse" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "sessionId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "itemVersion" INTEGER NOT NULL,
    "answer" JSONB NOT NULL,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "timeSpentSec" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "CandidateTestResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTestIntegrityEvent" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "sessionId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "detail" JSONB NOT NULL,

    CONSTRAINT "CandidateTestIntegrityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTestResult" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "sessionId" INTEGER NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "interviewId" INTEGER NOT NULL,
    "rawScore" DOUBLE PRECISION NOT NULL,
    "maxScore" DOUBLE PRECISION NOT NULL,
    "scorePct" DOUBLE PRECISION NOT NULL,
    "sectionScores" JSONB NOT NULL,
    "mustPassFailed" BOOLEAN NOT NULL,
    "band" TEXT NOT NULL,
    "percentile" DOUBLE PRECISION,
    "integrityFlagCount" INTEGER NOT NULL,
    "decision" TEXT,
    "decidedById" INTEGER,
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "CandidateTestResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewQuestion" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "competencyKey" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "followUps" JSONB NOT NULL,
    "goodAnswerGuide" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "InterviewQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateEvaluationSummary" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "applicationId" INTEGER NOT NULL,
    "interviewId" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "testScorePct" DOUBLE PRECISION,
    "interviewScorePct" DOUBLE PRECISION,
    "compositeScore" DOUBLE PRECISION,
    "weights" JSONB NOT NULL,
    "rankAtSnapshot" INTEGER,
    "pdfMediaId" TEXT,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "CandidateEvaluationSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateTestItem_tenantId_status_competencyKey_difficulty__idx" ON "CandidateTestItem"("tenantId", "status", "competencyKey", "difficulty", "language");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateTestItem_tenantId_itemCode_version_key" ON "CandidateTestItem"("tenantId", "itemCode", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateTestItemStat_tenantId_itemId_period_key" ON "CandidateTestItemStat"("tenantId", "itemId", "period");

-- CreateIndex
CREATE INDEX "CandidateTestBlueprint_tenantId_status_idx" ON "CandidateTestBlueprint"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateTestBlueprint_tenantId_name_version_key" ON "CandidateTestBlueprint"("tenantId", "name", "version");

-- CreateIndex
CREATE INDEX "CandidateTestBlueprintLink_tenantId_scopeType_scopeId_isAct_idx" ON "CandidateTestBlueprintLink"("tenantId", "scopeType", "scopeId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TestWorkstation_deviceTokenHash_key" ON "TestWorkstation"("deviceTokenHash");

-- CreateIndex
CREATE INDEX "TestWorkstation_tenantId_status_siteRef_idx" ON "TestWorkstation"("tenantId", "status", "siteRef");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateCheckIn_interviewId_key" ON "CandidateCheckIn"("interviewId");

-- CreateIndex
CREATE INDEX "CandidateCheckIn_tenantId_candidateId_idx" ON "CandidateCheckIn"("tenantId", "candidateId");

-- CreateIndex
CREATE INDEX "CandidateTestSession_tenantId_status_deadlineAt_idx" ON "CandidateTestSession"("tenantId", "status", "deadlineAt");

-- CreateIndex
CREATE INDEX "CandidateTestSession_tenantId_candidateId_idx" ON "CandidateTestSession"("tenantId", "candidateId");

-- CreateIndex
CREATE INDEX "CandidateTestSession_tenantId_interviewId_idx" ON "CandidateTestSession"("tenantId", "interviewId");

-- CreateIndex
CREATE INDEX "CandidateTestResponse_tenantId_sessionId_idx" ON "CandidateTestResponse"("tenantId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateTestResponse_sessionId_itemId_key" ON "CandidateTestResponse"("sessionId", "itemId");

-- CreateIndex
CREATE INDEX "CandidateTestIntegrityEvent_tenantId_sessionId_occurredAt_idx" ON "CandidateTestIntegrityEvent"("tenantId", "sessionId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateTestResult_sessionId_key" ON "CandidateTestResult"("sessionId");

-- CreateIndex
CREATE INDEX "CandidateTestResult_tenantId_applicationId_idx" ON "CandidateTestResult"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "InterviewQuestion_tenantId_competencyKey_status_idx" ON "InterviewQuestion"("tenantId", "competencyKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateEvaluationSummary_interviewId_key" ON "CandidateEvaluationSummary"("interviewId");

-- CreateIndex
CREATE INDEX "CandidateEvaluationSummary_tenantId_applicationId_idx" ON "CandidateEvaluationSummary"("tenantId", "applicationId");


-- Candidate-owned assessment tables are tenant-fenced before exposure.
ALTER TABLE "CandidateTestItem" ADD CONSTRAINT "CandidateTestItem_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CandidateTestItem" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "CandidateTestItem_tenant_id_key" ON "CandidateTestItem" ("tenantId",id);
ALTER TABLE "CandidateTestItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestItem_tenant_policy" ON "CandidateTestItem" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "CandidateTestItemStat" ADD CONSTRAINT "CandidateTestItemStat_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CandidateTestItemStat" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "CandidateTestItemStat_tenant_id_key" ON "CandidateTestItemStat" ("tenantId",id);
ALTER TABLE "CandidateTestItemStat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestItemStat" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestItemStat_tenant_policy" ON "CandidateTestItemStat" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "CandidateTestBlueprint" ADD CONSTRAINT "CandidateTestBlueprint_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CandidateTestBlueprint" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "CandidateTestBlueprint_tenant_id_key" ON "CandidateTestBlueprint" ("tenantId",id);
ALTER TABLE "CandidateTestBlueprint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestBlueprint" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestBlueprint_tenant_policy" ON "CandidateTestBlueprint" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "CandidateTestBlueprintLink" ADD CONSTRAINT "CandidateTestBlueprintLink_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CandidateTestBlueprintLink" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "CandidateTestBlueprintLink_tenant_id_key" ON "CandidateTestBlueprintLink" ("tenantId",id);
ALTER TABLE "CandidateTestBlueprintLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestBlueprintLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestBlueprintLink_tenant_policy" ON "CandidateTestBlueprintLink" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "TestWorkstation" ADD CONSTRAINT "TestWorkstation_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "TestWorkstation" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "TestWorkstation_tenant_id_key" ON "TestWorkstation" ("tenantId",id);
ALTER TABLE "TestWorkstation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TestWorkstation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "TestWorkstation_tenant_policy" ON "TestWorkstation" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "CandidateCheckIn" ADD CONSTRAINT "CandidateCheckIn_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CandidateCheckIn" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "CandidateCheckIn_tenant_id_key" ON "CandidateCheckIn" ("tenantId",id);
ALTER TABLE "CandidateCheckIn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateCheckIn" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateCheckIn_tenant_policy" ON "CandidateCheckIn" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "CandidateTestSession" ADD CONSTRAINT "CandidateTestSession_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CandidateTestSession" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "CandidateTestSession_tenant_id_key" ON "CandidateTestSession" ("tenantId",id);
ALTER TABLE "CandidateTestSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestSession_tenant_policy" ON "CandidateTestSession" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "CandidateTestResponse" ADD CONSTRAINT "CandidateTestResponse_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CandidateTestResponse" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "CandidateTestResponse_tenant_id_key" ON "CandidateTestResponse" ("tenantId",id);
ALTER TABLE "CandidateTestResponse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestResponse" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestResponse_tenant_policy" ON "CandidateTestResponse" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "CandidateTestIntegrityEvent" ADD CONSTRAINT "CandidateTestIntegrityEvent_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CandidateTestIntegrityEvent" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "CandidateTestIntegrityEvent_tenant_id_key" ON "CandidateTestIntegrityEvent" ("tenantId",id);
ALTER TABLE "CandidateTestIntegrityEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestIntegrityEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestIntegrityEvent_tenant_policy" ON "CandidateTestIntegrityEvent" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "CandidateTestResult" ADD CONSTRAINT "CandidateTestResult_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CandidateTestResult" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "CandidateTestResult_tenant_id_key" ON "CandidateTestResult" ("tenantId",id);
ALTER TABLE "CandidateTestResult" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestResult" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestResult_tenant_policy" ON "CandidateTestResult" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "InterviewQuestion" ADD CONSTRAINT "InterviewQuestion_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "InterviewQuestion" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "InterviewQuestion_tenant_id_key" ON "InterviewQuestion" ("tenantId",id);
ALTER TABLE "InterviewQuestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InterviewQuestion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "InterviewQuestion_tenant_policy" ON "InterviewQuestion" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "CandidateEvaluationSummary" ADD CONSTRAINT "CandidateEvaluationSummary_tenant_required" CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "CandidateEvaluationSummary" ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant();
CREATE UNIQUE INDEX "CandidateEvaluationSummary_tenant_id_key" ON "CandidateEvaluationSummary" ("tenantId",id);
ALTER TABLE "CandidateEvaluationSummary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateEvaluationSummary" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateEvaluationSummary_tenant_policy" ON "CandidateEvaluationSummary" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');

-- Composite foreign keys prevent same-tenant and cross-tenant misbinding.
CREATE UNIQUE INDEX IF NOT EXISTS "recruitment_Candidate_tenant_id_key" ON "Candidate" ("tenantId",id);
CREATE UNIQUE INDEX IF NOT EXISTS "recruitment_Application_tenant_id_key" ON "Application" ("tenantId",id);
CREATE UNIQUE INDEX IF NOT EXISTS "recruitment_interviews_tenant_id_key" ON "interviews" ("tenantId",id);
CREATE UNIQUE INDEX IF NOT EXISTS "recruitment_skills_tenant_id_key" ON "skills" ("tenantId",id);
ALTER TABLE "CandidateTestItem" ADD CONSTRAINT "CandidateTestItem_skillId_tenant_fk" FOREIGN KEY ("tenantId","skillId") REFERENCES "skills" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestItemStat" ADD CONSTRAINT "CandidateTestItemStat_itemId_tenant_fk" FOREIGN KEY ("tenantId","itemId") REFERENCES "CandidateTestItem" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestBlueprintLink" ADD CONSTRAINT "CandidateTestBlueprintLink_blueprintId_tenant_fk" FOREIGN KEY ("tenantId","blueprintId") REFERENCES "CandidateTestBlueprint" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateCheckIn" ADD CONSTRAINT "CandidateCheckIn_interviewId_tenant_fk" FOREIGN KEY ("tenantId","interviewId") REFERENCES "interviews" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateCheckIn" ADD CONSTRAINT "CandidateCheckIn_candidateId_tenant_fk" FOREIGN KEY ("tenantId","candidateId") REFERENCES "Candidate" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestSession" ADD CONSTRAINT "CandidateTestSession_applicationId_tenant_fk" FOREIGN KEY ("tenantId","applicationId") REFERENCES "Application" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestSession" ADD CONSTRAINT "CandidateTestSession_candidateId_tenant_fk" FOREIGN KEY ("tenantId","candidateId") REFERENCES "Candidate" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestSession" ADD CONSTRAINT "CandidateTestSession_interviewId_tenant_fk" FOREIGN KEY ("tenantId","interviewId") REFERENCES "interviews" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestSession" ADD CONSTRAINT "CandidateTestSession_blueprintId_tenant_fk" FOREIGN KEY ("tenantId","blueprintId") REFERENCES "CandidateTestBlueprint" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestSession" ADD CONSTRAINT "CandidateTestSession_workstationId_tenant_fk" FOREIGN KEY ("tenantId","workstationId") REFERENCES "TestWorkstation" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestResponse" ADD CONSTRAINT "CandidateTestResponse_sessionId_tenant_fk" FOREIGN KEY ("tenantId","sessionId") REFERENCES "CandidateTestSession" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestResponse" ADD CONSTRAINT "CandidateTestResponse_itemId_tenant_fk" FOREIGN KEY ("tenantId","itemId") REFERENCES "CandidateTestItem" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestIntegrityEvent" ADD CONSTRAINT "CandidateTestIntegrityEvent_sessionId_tenant_fk" FOREIGN KEY ("tenantId","sessionId") REFERENCES "CandidateTestSession" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestResult" ADD CONSTRAINT "CandidateTestResult_sessionId_tenant_fk" FOREIGN KEY ("tenantId","sessionId") REFERENCES "CandidateTestSession" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestResult" ADD CONSTRAINT "CandidateTestResult_applicationId_tenant_fk" FOREIGN KEY ("tenantId","applicationId") REFERENCES "Application" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateTestResult" ADD CONSTRAINT "CandidateTestResult_interviewId_tenant_fk" FOREIGN KEY ("tenantId","interviewId") REFERENCES "interviews" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateEvaluationSummary" ADD CONSTRAINT "CandidateEvaluationSummary_applicationId_tenant_fk" FOREIGN KEY ("tenantId","applicationId") REFERENCES "Application" ("tenantId",id) ON DELETE RESTRICT;
ALTER TABLE "CandidateEvaluationSummary" ADD CONSTRAINT "CandidateEvaluationSummary_interviewId_tenant_fk" FOREIGN KEY ("tenantId","interviewId") REFERENCES "interviews" ("tenantId",id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX "CandidateTestBlueprintLink_active_scope_key" ON "CandidateTestBlueprintLink" ("tenantId","scopeType","scopeId") WHERE "isActive";
CREATE UNIQUE INDEX "CandidateTestSession_active_interview_key" ON "CandidateTestSession" ("tenantId","interviewId") WHERE status IN ('ISSUED','IN_PROGRESS','PAUSED');
ALTER TABLE "CandidateTestItem" ADD CONSTRAINT "candidate_test_item_review_sod" CHECK (status <> 'PUBLISHED' OR ("reviewerId" IS NOT NULL AND "reviewerId" <> "authorId"));
ALTER TABLE "CandidateTestBlueprint" ADD CONSTRAINT "candidate_test_blueprint_sod" CHECK (status <> 'PUBLISHED' OR ("approvedByHrId" IS NOT NULL AND "approvedByHiringManagerId" IS NOT NULL AND "approvedByHrId" <> "approvedByHiringManagerId" AND "createdById" NOT IN ("approvedByHrId","approvedByHiringManagerId")));
ALTER TABLE "CandidateCheckIn" ADD CONSTRAINT "candidate_checkin_minimal_id" CHECK ("idLast4" ~ '^[0-9]{4}$' AND ("photoMediaId" IS NULL OR "photoConsentAt" IS NOT NULL));
ALTER TABLE "CandidateTestSession" ADD CONSTRAINT "candidate_test_session_accommodation" CHECK ("extraTimePct" BETWEEN 0 AND 50);
CREATE FUNCTION hr_candidate_test_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('PUBLISHED','RETIRED') AND (to_jsonb(OLD)-ARRAY['status','revision','updatedAt','exposureCount','reviewComment']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','revision','updatedAt','exposureCount','reviewComment']) THEN RAISE EXCEPTION 'HR-6008: published assessment versions are immutable'; END IF;
 IF OLD.status='RETIRED' AND NEW.status<>'RETIRED' THEN RAISE EXCEPTION 'HR-6008: retired versions cannot be republished'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_test_item_immutable BEFORE UPDATE ON "CandidateTestItem" FOR EACH ROW EXECUTE FUNCTION hr_candidate_test_catalog_immutable();
CREATE TRIGGER candidate_test_blueprint_immutable BEFORE UPDATE ON "CandidateTestBlueprint" FOR EACH ROW EXECUTE FUNCTION hr_candidate_test_catalog_immutable();
CREATE FUNCTION hr_candidate_test_response_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "CandidateTestSession";
BEGIN
 SELECT * INTO s FROM "CandidateTestSession" WHERE id=NEW."sessionId" AND "tenantId"=NEW."tenantId" FOR UPDATE;
 IF s.id IS NULL OR s.status<>'IN_PROGRESS' OR s."deadlineAt"<=(clock_timestamp() AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'HR-6009: session is not accepting answers'; END IF;
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s."itemOrder") i WHERE (i->>'itemId')::integer=NEW."itemId" AND (i->>'itemVersion')::integer=NEW."itemVersion") THEN RAISE EXCEPTION 'HR-6009: item was not assigned to this session'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_test_response_guard BEFORE INSERT OR UPDATE ON "CandidateTestResponse" FOR EACH ROW EXECUTE FUNCTION hr_candidate_test_response_guard();

-- The assessment gate also protects legacy and direct SQL write paths.
CREATE FUNCTION hr_candidate_assessment_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i interviews;
BEGIN
 IF TG_TABLE_NAME='interviews' THEN
  IF NEW.status='COMPLETED' AND NEW."assessmentStatus" NOT IN ('NOT_REQUIRED','PASSED','BORDERLINE','OVERRIDDEN','WAIVED') THEN RAISE EXCEPTION 'HR-6001: assessment must be resolved before interview outcome'; END IF;
 ELSE
  IF NEW."submittedAt" IS NOT NULL THEN
   SELECT * INTO i FROM interviews WHERE id=NEW."interviewId" AND "tenantId"=NEW."tenantId" FOR UPDATE;
   IF i.id IS NULL OR i."assessmentStatus" NOT IN ('NOT_REQUIRED','PASSED','BORDERLINE','OVERRIDDEN','WAIVED') THEN RAISE EXCEPTION 'HR-6001: assessment must be resolved before feedback'; END IF;
   IF i."formSnapshot" IS NOT NULL AND (NEW."templateVersion" IS DISTINCT FROM i."formTemplateVersion" OR NOT NEW."coiDeclared" OR NEW."criterionScores" IS NULL) THEN RAISE EXCEPTION 'HR-6101: structured form and conflict declaration required'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_assessment_outcome_gate BEFORE INSERT OR UPDATE ON interviews FOR EACH ROW EXECUTE FUNCTION hr_candidate_assessment_gate();
CREATE TRIGGER candidate_assessment_scorecard_gate BEFORE INSERT OR UPDATE ON interview_scorecards FOR EACH ROW EXECUTE FUNCTION hr_candidate_assessment_gate();

ALTER TABLE scorecard_template_links DROP CONSTRAINT scorecard_template_links_scoptype_check;
ALTER TABLE scorecard_template_links ADD CONSTRAINT scorecard_template_links_scoptype_check CHECK ("scopeType" IN ('REQUISITION','INTERVIEW_TYPE','PANEL_ROLE','STAGE','JOB_FAMILY'));
ALTER TABLE scorecard_template_links DROP CONSTRAINT scorecard_template_links_scope_addressing_check;
ALTER TABLE scorecard_template_links ADD CONSTRAINT scorecard_template_links_scope_addressing_check CHECK (("scopeType" IN ('REQUISITION','JOB_FAMILY') AND "scopeId" IS NOT NULL AND "scopeKey" IS NULL) OR ("scopeType" IN ('INTERVIEW_TYPE','PANEL_ROLE','STAGE') AND "scopeKey" IS NOT NULL AND "scopeId" IS NULL));
-- Preserve the status of pre-existing legacy templates and submitted scorecards.
UPDATE scorecard_templates SET status='PUBLISHED' WHERE sections IS NULL;
UPDATE interview_scorecards SET status='SUBMITTED' WHERE "submittedAt" IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON "CandidateTestItem" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "CandidateTestItem_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CandidateTestItemStat" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "CandidateTestItemStat_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CandidateTestBlueprint" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "CandidateTestBlueprint_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CandidateTestBlueprintLink" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "CandidateTestBlueprintLink_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TestWorkstation" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "TestWorkstation_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CandidateCheckIn" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "CandidateCheckIn_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CandidateTestSession" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "CandidateTestSession_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CandidateTestResponse" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "CandidateTestResponse_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CandidateTestIntegrityEvent" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "CandidateTestIntegrityEvent_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CandidateTestResult" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "CandidateTestResult_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "InterviewQuestion" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "InterviewQuestion_id_seq" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CandidateEvaluationSummary" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "CandidateEvaluationSummary_id_seq" TO hr_app;

-- Bind assessment outcomes to the interview/application that produced them.
ALTER TABLE "interviews" ADD COLUMN "assessmentResultId" INTEGER;
ALTER TABLE "CandidateTestSession" ADD COLUMN "itemStartedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Application_assessment_identity" ON "Application" ("tenantId",id,"candidateId","jobRequisitionId");
CREATE UNIQUE INDEX "Application_assessment_candidate" ON "Application" ("tenantId",id,"candidateId");
CREATE UNIQUE INDEX "interviews_assessment_application" ON interviews ("tenantId",id,"applicationId");
CREATE UNIQUE INDEX "CandidateTestSession_assessment_identity" ON "CandidateTestSession" ("tenantId",id,"applicationId","interviewId");
ALTER TABLE "offers" ADD CONSTRAINT "offer_application_identity" FOREIGN KEY ("tenantId","applicationId","candidateId","jobRequisitionId") REFERENCES "Application" ("tenantId",id,"candidateId","jobRequisitionId") NOT VALID;
ALTER TABLE "CandidateTestSession" ADD CONSTRAINT "test_session_application_identity" FOREIGN KEY ("tenantId","applicationId","candidateId") REFERENCES "Application" ("tenantId",id,"candidateId");
ALTER TABLE "CandidateTestSession" ADD CONSTRAINT "test_session_interview_identity" FOREIGN KEY ("tenantId","interviewId","applicationId") REFERENCES interviews ("tenantId",id,"applicationId");
ALTER TABLE "CandidateTestResult" ADD CONSTRAINT "test_result_session_identity" FOREIGN KEY ("tenantId","sessionId","applicationId","interviewId") REFERENCES "CandidateTestSession" ("tenantId",id,"applicationId","interviewId");
ALTER TABLE "CandidateEvaluationSummary" ADD CONSTRAINT "evaluation_interview_identity" FOREIGN KEY ("tenantId","interviewId","applicationId") REFERENCES interviews ("tenantId",id,"applicationId");
ALTER TABLE interviews ADD CONSTRAINT "assessment_result_tenant" FOREIGN KEY ("tenantId","assessmentResultId") REFERENCES "CandidateTestResult" ("tenantId",id);

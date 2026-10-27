-- CreateEnum
CREATE TYPE "EmploymentCategory" AS ENUM ('MANAGEMENT', 'EMPLOYEE', 'INTERNEE');

-- CreateEnum
CREATE TYPE "SeparationType" AS ENUM ('RESIGNATION', 'TERMINATION_WITH_CAUSE', 'TERMINATION_WITHOUT_CAUSE', 'CONTRACT_END', 'INTERNSHIP_COMPLETION', 'RETIREMENT', 'MUTUAL_SEPARATION', 'DEATH_IN_SERVICE');

-- CreateEnum
CREATE TYPE "SeparationState" AS ENUM ('DRAFT', 'SUBMITTED', 'MANAGER_REVIEW', 'HR_VERIFICATION', 'MANAGEMENT_DECISION', 'APPROVED', 'NOTICE_PERIOD', 'HANDOVER_IN_PROGRESS', 'CLEARANCE', 'EXIT_COMPLETED', 'WITHDRAWN', 'CANCELLED');

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "contractNoticeDays" INTEGER,
ADD COLUMN     "employeeCategory" "EmploymentCategory",
ADD COLUMN     "rehireEligible" BOOLEAN,
ADD COLUMN     "separatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmployeeCodeConfiguration" (
    "tenantId" UUID NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "separator" TEXT NOT NULL DEFAULT '-',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeCodeConfiguration_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "EmployeeCodeSequence" (
    "tenantId" UUID NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastValue" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeCodeSequence_pkey" PRIMARY KEY ("tenantId","prefix")
);

-- CreateTable
CREATE TABLE "EmployeeCodeReservation" (
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "collisionKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeCodeReservation_pkey" PRIMARY KEY ("tenantId","employeeCode")
);

-- CreateTable
CREATE TABLE "EmployeeCodeAlias" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "newCode" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "actorCode" TEXT NOT NULL,
    "conversionRef" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeCodeAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeCategoryConversion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "category" "EmploymentCategory" NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedByCode" TEXT NOT NULL,
    "approvedByCode" TEXT,
    "state" TEXT NOT NULL DEFAULT 'REQUESTED',
    "newCode" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeCategoryConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeparationPolicy" (
    "tenantId" UUID NOT NULL,
    "policy" JSONB NOT NULL,
    "actorCode" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeparationPolicy_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "Separation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "type" "SeparationType" NOT NULL,
    "state" "SeparationState" NOT NULL DEFAULT 'DRAFT',
    "reasonCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "proposedLastWorkingAt" TIMESTAMP(3) NOT NULL,
    "lastWorkingAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "deferredUntil" TIMESTAMP(3),
    "withdrawalRequestedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "accessDueEmittedAt" TIMESTAMP(3),
    "createdByCode" TEXT NOT NULL,
    "managerCode" TEXT,
    "category" "EmploymentCategory" NOT NULL,
    "gradeCode" TEXT NOT NULL,
    "policySnapshot" JSONB NOT NULL,
    "recommendation" JSONB,
    "verification" JSONB,
    "verifiedByCode" TEXT,
    "documents" JSONB NOT NULL,
    "rehireEligible" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Separation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeparationTransition" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeparationTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoticePeriodRecord" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoticePeriodRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplacementPlan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplacementPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplacementSession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplacementSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeTransferItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeTransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetHandoverItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetHandoverItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRevocationTask" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessRevocationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClearanceItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClearanceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExitInterview" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExitInterview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinalSettlementSheet" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinalSettlementSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeparationDocument" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeparationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeparationSourceSnapshot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "separationRef" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ownerCode" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeparationSourceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmploymentCommandReceipt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "requestKey" UUID NOT NULL,
    "actorCode" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmploymentCommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmploymentDelivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmploymentDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeCodeReservation_tenantId_collisionKey_key" ON "EmployeeCodeReservation"("tenantId", "collisionKey");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeCodeAlias_tenantId_employeeCode_key" ON "EmployeeCodeAlias"("tenantId", "employeeCode");

-- CreateIndex
CREATE INDEX "EmployeeCategoryConversion_tenantId_state_effectiveAt_idx" ON "EmployeeCategoryConversion"("tenantId", "state", "effectiveAt");

-- CreateIndex
CREATE INDEX "Separation_tenantId_employeeCode_state_idx" ON "Separation"("tenantId", "employeeCode", "state");

-- CreateIndex
CREATE INDEX "Separation_tenantId_deferredUntil_idx" ON "Separation"("tenantId", "deferredUntil");

-- CreateIndex
CREATE UNIQUE INDEX "Separation_tenantId_id_key" ON "Separation"("tenantId", "id");

-- CreateIndex
CREATE INDEX "SeparationTransition_tenantId_employeeCode_idx" ON "SeparationTransition"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "SeparationTransition_tenantId_separationRef_key_key" ON "SeparationTransition"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "NoticePeriodRecord_tenantId_employeeCode_idx" ON "NoticePeriodRecord"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "NoticePeriodRecord_tenantId_separationRef_key_key" ON "NoticePeriodRecord"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "ReplacementPlan_tenantId_employeeCode_idx" ON "ReplacementPlan"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "ReplacementPlan_tenantId_separationRef_key_key" ON "ReplacementPlan"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "ReplacementSession_tenantId_employeeCode_idx" ON "ReplacementSession"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "ReplacementSession_tenantId_separationRef_key_key" ON "ReplacementSession"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "KnowledgeTransferItem_tenantId_employeeCode_idx" ON "KnowledgeTransferItem"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeTransferItem_tenantId_separationRef_key_key" ON "KnowledgeTransferItem"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "AssetHandoverItem_tenantId_employeeCode_idx" ON "AssetHandoverItem"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "AssetHandoverItem_tenantId_separationRef_key_key" ON "AssetHandoverItem"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "AccessRevocationTask_tenantId_employeeCode_idx" ON "AccessRevocationTask"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRevocationTask_tenantId_separationRef_key_key" ON "AccessRevocationTask"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "ClearanceItem_tenantId_employeeCode_idx" ON "ClearanceItem"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "ClearanceItem_tenantId_separationRef_key_key" ON "ClearanceItem"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "ExitInterview_tenantId_employeeCode_idx" ON "ExitInterview"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "ExitInterview_tenantId_separationRef_key_key" ON "ExitInterview"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "FinalSettlementSheet_tenantId_employeeCode_idx" ON "FinalSettlementSheet"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "FinalSettlementSheet_tenantId_separationRef_key_key" ON "FinalSettlementSheet"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "SeparationDocument_tenantId_employeeCode_idx" ON "SeparationDocument"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "SeparationDocument_tenantId_separationRef_key_key" ON "SeparationDocument"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE INDEX "SeparationSourceSnapshot_tenantId_employeeCode_idx" ON "SeparationSourceSnapshot"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "SeparationSourceSnapshot_tenantId_separationRef_key_key" ON "SeparationSourceSnapshot"("tenantId", "separationRef", "key");

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentCommandReceipt_tenantId_requestKey_key" ON "EmploymentCommandReceipt"("tenantId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentDelivery_tenantId_key_key" ON "EmploymentDelivery"("tenantId", "key");

-- CreateIndex


-- AddForeignKey
ALTER TABLE "SeparationTransition" ADD CONSTRAINT "SeparationTransition_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticePeriodRecord" ADD CONSTRAINT "NoticePeriodRecord_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplacementPlan" ADD CONSTRAINT "ReplacementPlan_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplacementSession" ADD CONSTRAINT "ReplacementSession_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeTransferItem" ADD CONSTRAINT "KnowledgeTransferItem_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetHandoverItem" ADD CONSTRAINT "AssetHandoverItem_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRevocationTask" ADD CONSTRAINT "AccessRevocationTask_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClearanceItem" ADD CONSTRAINT "ClearanceItem_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExitInterview" ADD CONSTRAINT "ExitInterview_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinalSettlementSheet" ADD CONSTRAINT "FinalSettlementSheet_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeparationDocument" ADD CONSTRAINT "SeparationDocument_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeparationSourceSnapshot" ADD CONSTRAINT "SeparationSourceSnapshot_tenantId_separationRef_fkey" FOREIGN KEY ("tenantId", "separationRef") REFERENCES "Separation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Employment security guards
ALTER TABLE "EmployeeCodeConfiguration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeCodeConfiguration" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "EmployeeCodeConfiguration" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "EmployeeCodeSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeCodeSequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "EmployeeCodeSequence" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "EmployeeCodeReservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeCodeReservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "EmployeeCodeReservation" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "EmployeeCodeAlias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeCodeAlias" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "EmployeeCodeAlias" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "EmployeeCategoryConversion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeCategoryConversion" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "EmployeeCategoryConversion" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "SeparationPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SeparationPolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "SeparationPolicy" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "Separation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Separation" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "Separation" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "EmploymentCommandReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmploymentCommandReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "EmploymentCommandReceipt" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "EmploymentDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmploymentDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "EmploymentDelivery" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "SeparationTransition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SeparationTransition" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "SeparationTransition" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "NoticePeriodRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NoticePeriodRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "NoticePeriodRecord" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "ReplacementPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReplacementPlan" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "ReplacementPlan" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "ReplacementSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReplacementSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "ReplacementSession" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "KnowledgeTransferItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeTransferItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "KnowledgeTransferItem" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "AssetHandoverItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetHandoverItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "AssetHandoverItem" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "AccessRevocationTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccessRevocationTask" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "AccessRevocationTask" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "ClearanceItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClearanceItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "ClearanceItem" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "ExitInterview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExitInterview" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "ExitInterview" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "FinalSettlementSheet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinalSettlementSheet" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "FinalSettlementSheet" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "SeparationDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SeparationDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "SeparationDocument" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "SeparationSourceSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SeparationSourceSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY employment_tenant ON "SeparationSourceSnapshot" USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');

CREATE FUNCTION hr_reserve_employee_code() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conversion "EmployeeCategoryConversion"; correction "AssessmentCodeChange"; canonical text;
BEGIN
 IF NEW.tenant_id IS NULL OR NEW.employee_code IS NULL OR btrim(NEW.employee_code)='' THEN
   RAISE EXCEPTION 'HR-4601: Company and employee code are mandatory';
 END IF;
 IF TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN RAISE EXCEPTION 'HR-4607: Employee company identity is immutable'; END IF;
 IF TG_OP='UPDATE' AND NEW.employee_code IS NOT DISTINCT FROM OLD.employee_code AND NEW."employeeCategory" IS NOT DISTINCT FROM OLD."employeeCategory" THEN RETURN NEW; END IF;
 IF NEW.employee_code <> btrim(NEW.employee_code) OR NEW.employee_code !~ '^[A-Z0-9]+([-_][A-Z0-9]+)*$' THEN RAISE EXCEPTION 'HR-4602: Employee code must be canonical uppercase text'; END IF;
 IF TG_OP='INSERT' AND NEW."employeeCategory" IS NULL THEN RAISE EXCEPTION 'HR-4603: Explicit employee category is required'; END IF;
 IF TG_OP='UPDATE' AND OLD.employee_code IS NOT NULL AND btrim(OLD.employee_code)<>'' AND NEW.employee_code IS DISTINCT FROM OLD.employee_code THEN
   SELECT * INTO correction FROM "AssessmentCodeChange" WHERE id=nullif(current_setting('app.assessment_code_change',true),'')::uuid AND "tenantId"=NEW.tenant_id AND "oldCode"=OLD.employee_code AND "newCode"=NEW.employee_code;
   IF correction.id IS NULL THEN RAISE EXCEPTION 'HR-4604: Approved code change required'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD."employeeCategory" IS NOT NULL AND NEW."employeeCategory" IS DISTINCT FROM OLD."employeeCategory" THEN
   SELECT * INTO conversion FROM "EmployeeCategoryConversion" WHERE id=nullif(current_setting('app.employee_category_conversion',true),'')::uuid AND "tenantId"=NEW.tenant_id AND "employeeCode" IN (OLD.employee_code,NEW.employee_code) AND category=NEW."employeeCategory" AND state='APPROVED' AND "effectiveAt"<=now();
   IF conversion.id IS NULL THEN RAISE EXCEPTION 'HR-4605: Approved category conversion required'; END IF;
 END IF;
 IF TG_OP='INSERT' OR NEW.employee_code IS DISTINCT FROM OLD.employee_code THEN
   canonical:=regexp_replace(NEW.employee_code,'[-_]','','g');
   INSERT INTO "EmployeeCodeReservation" ("tenantId","employeeCode","collisionKey","updatedAt") VALUES (NEW.tenant_id,NEW.employee_code,canonical,now());
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_employee_code_guard BEFORE INSERT OR UPDATE ON "Employee" FOR EACH ROW EXECUTE FUNCTION hr_reserve_employee_code();
CREATE FUNCTION hr_employment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'HR-4606: Historical employment records are immutable'; END $$;
CREATE TRIGGER hr_code_reservation_immutable BEFORE UPDATE OR DELETE ON "EmployeeCodeReservation" FOR EACH ROW EXECUTE FUNCTION hr_employment_immutable();
CREATE TRIGGER hr_code_alias_immutable BEFORE UPDATE OR DELETE ON "EmployeeCodeAlias" FOR EACH ROW EXECUTE FUNCTION hr_employment_immutable();
CREATE TRIGGER hr_separation_history_immutable BEFORE UPDATE OR DELETE ON "SeparationTransition" FOR EACH ROW EXECUTE FUNCTION hr_employment_immutable();
CREATE UNIQUE INDEX hr_one_open_separation ON "Separation"("tenantId","employeeCode") WHERE state NOT IN ('EXIT_COMPLETED','WITHDRAWN','CANCELLED');

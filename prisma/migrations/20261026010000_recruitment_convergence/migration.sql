ALTER TABLE "HrApprovalRequest" ADD COLUMN "recruitmentPolicy" JSONB;
ALTER TABLE "offers" ADD COLUMN "employeeCategory" "EmploymentCategory";

ALTER TABLE "HrApprovalRequest" ADD COLUMN "policyRole" TEXT, ADD COLUMN "policyApproverId" INTEGER, ADD COLUMN "policyPermission" TEXT;
ALTER TABLE "HrApprovalReceipt" ADD COLUMN "authorization" JSONB;
CREATE INDEX "HrApprovalRequest_policy_queue_idx" ON "HrApprovalRequest" ("tenantId", "stage", "policyPermission", "policyRole");

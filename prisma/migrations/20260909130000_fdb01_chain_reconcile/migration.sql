-- F-DB-01 — reconciliation migration: aligns the deployed chain with
-- prisma/schema.prisma. Generated via 'prisma migrate diff' from a chain-
-- deployed scratch DB to schema (FK name normalization, defaults Prisma
-- does not manage, index renames from prior raw-SQL migrations).

-- DropForeignKey
ALTER TABLE "attendance_anomaly_approvals" DROP CONSTRAINT "attendance_anomaly_approvals_anomalyId_fkey";

-- DropForeignKey
ALTER TABLE "attendance_anomaly_approvals" DROP CONSTRAINT "attendance_anomaly_approvals_approverId_fkey";

-- DropForeignKey
ALTER TABLE "attendance_approval_levels" DROP CONSTRAINT "attendance_approval_levels_approverId_fkey";

-- DropForeignKey
ALTER TABLE "overtime_request_approvals" DROP CONSTRAINT "overtime_request_approvals_approverId_fkey";

-- DropForeignKey
ALTER TABLE "overtime_request_approvals" DROP CONSTRAINT "overtime_request_approvals_overtimeRequestId_fkey";

-- AlterTable
ALTER TABLE "attendance_approval_levels" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "attendance_deduction_rules" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "attendance_device_punches" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "attendance_policy_config" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "payroll_rules" ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "attendance_anomaly_approvals" ADD CONSTRAINT "attendance_anomaly_approvals_anomalyId_fkey" FOREIGN KEY ("anomalyId") REFERENCES "attendance_anomalies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_anomaly_approvals" ADD CONSTRAINT "attendance_anomaly_approvals_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_approval_levels" ADD CONSTRAINT "attendance_approval_levels_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_request_approvals" ADD CONSTRAINT "overtime_request_approvals_overtimeRequestId_fkey" FOREIGN KEY ("overtimeRequestId") REFERENCES "overtime_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_request_approvals" ADD CONSTRAINT "overtime_request_approvals_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "idx_employee_personid" RENAME TO "Employee_personId_idx";

-- RenameIndex
ALTER INDEX "employee_device_enrolments_tenant_device_from_idx" RENAME TO "employee_device_enrolments_tenantId_deviceUserId_effectiveF_idx";

-- RenameIndex
ALTER INDEX "employee_device_enrolments_tenant_employee_from_idx" RENAME TO "employee_device_enrolments_tenantId_employeeId_effectiveFro_idx";

-- RenameIndex
ALTER INDEX "overtime_request_approvals_req_level_key" RENAME TO "overtime_request_approvals_overtimeRequestId_level_key";


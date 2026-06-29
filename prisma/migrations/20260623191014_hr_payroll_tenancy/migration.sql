-- AlterTable
ALTER TABLE "bank_details" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "employment_terms" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "payroll_assignments" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "payroll_audit_logs" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "payroll_deduction_types" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "payroll_earning_types" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "payroll_payslips" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "tax_rates" ADD COLUMN     "tenantId" INTEGER;

-- CreateIndex
CREATE INDEX "bank_details_tenantId_idx" ON "bank_details"("tenantId");

-- CreateIndex
CREATE INDEX "employment_terms_tenantId_idx" ON "employment_terms"("tenantId");

-- CreateIndex
CREATE INDEX "payroll_assignments_tenantId_idx" ON "payroll_assignments"("tenantId");

-- CreateIndex
CREATE INDEX "payroll_audit_logs_tenantId_idx" ON "payroll_audit_logs"("tenantId");

-- CreateIndex
CREATE INDEX "payroll_deduction_types_tenantId_idx" ON "payroll_deduction_types"("tenantId");

-- CreateIndex
CREATE INDEX "payroll_earning_types_tenantId_idx" ON "payroll_earning_types"("tenantId");

-- CreateIndex
CREATE INDEX "payroll_payslips_tenantId_idx" ON "payroll_payslips"("tenantId");

-- CreateIndex
CREATE INDEX "payroll_runs_tenantId_idx" ON "payroll_runs"("tenantId");

-- CreateIndex
CREATE INDEX "tax_rates_tenantId_idx" ON "tax_rates"("tenantId");

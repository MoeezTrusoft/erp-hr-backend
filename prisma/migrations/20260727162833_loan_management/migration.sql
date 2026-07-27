-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'PAID_OFF', 'WRITTEN_OFF', 'DEFAULTED');

-- DropIndex
DROP INDEX "Attendance_tenantId_idx";

-- DropIndex
DROP INDEX "attendance_anomalies_tenantId_idx";

-- DropIndex
DROP INDEX "employment_terms_tenantId_idx";

-- DropIndex
DROP INDEX "outbox_events_publishedAt_claimExpiresAt_createdAt_idx";

-- DropIndex
DROP INDEX "outbox_events_publishedAt_createdAt_idx";

-- DropIndex
DROP INDEX "overtime_requests_tenantId_idx";

-- DropIndex
DROP INDEX "payroll_assignments_tenantId_idx";

-- DropIndex
DROP INDEX "payroll_audit_logs_tenantId_idx";

-- DropIndex
DROP INDEX "payroll_payslips_tenantId_idx";

-- DropIndex
DROP INDEX "system_account_provisioning_status_nextAttemptAt_claimExpir_idx";

-- DropIndex
DROP INDEX "tax_rates_tenantId_idx";

-- CreateTable
CREATE TABLE "loans" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "employeeId" INTEGER NOT NULL,
    "principalMinor" INTEGER NOT NULL,
    "interestRatePct" DOUBLE PRECISION DEFAULT 0,
    "tenureMonths" INTEGER NOT NULL,
    "disbursementDate" TIMESTAMP(3) NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "outstandingMinor" INTEGER NOT NULL,
    "monthlyInstallmentMinor" INTEGER NOT NULL,
    "reason" TEXT,
    "createdById" INTEGER,
    "approvedById" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_repayments" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "loanId" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "payrollRunId" INTEGER,
    "payslipId" INTEGER,
    "deductedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "loan_repayments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loans_tenantId_employeeId_status_idx" ON "loans"("tenantId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "loans_tenantId_status_idx" ON "loans"("tenantId", "status");

-- CreateIndex
CREATE INDEX "loan_repayments_tenantId_loanId_deductedAt_idx" ON "loan_repayments"("tenantId", "loanId", "deductedAt");

-- CreateIndex
CREATE INDEX "Attendance_tenant_employee_date_id_idx" ON "Attendance"("tenantId", "employeeId", "date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Attendance_tenant_date_checkin_id_idx" ON "Attendance"("tenantId", "date" DESC, "check_in" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "attendance_anomalies_tenant_status_created_id_idx" ON "attendance_anomalies"("tenantId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "employment_terms_tenant_employee_effective_id_idx" ON "employment_terms"("tenantId", "employeeId", "effectiveFrom" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "leave_requests_tenant_employee_status_dates_id_idx" ON "leave_requests"("tenantId", "employeeId", "status", "startDate", "endDate", "id");

-- CreateIndex
CREATE INDEX "leave_requests_tenant_status_created_id_idx" ON "leave_requests"("tenantId", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "overtime_requests_tenant_status_date_id_idx" ON "overtime_requests"("tenantId", "status", "date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "overtime_requests_tenant_employee_status_date_id_idx" ON "overtime_requests"("tenantId", "employeeId", "status", "date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "payroll_assignments_tenant_employee_active_effective_id_idx" ON "payroll_assignments"("tenantId", "employeeId", "isActive", "effectiveFrom" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "payroll_audit_logs_tenant_created_id_idx" ON "payroll_audit_logs"("tenantId", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "payroll_payslips_tenant_employee_created_id_idx" ON "payroll_payslips"("tenantId", "employeeId", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "tax_rates_tenant_country_effective_id_idx" ON "tax_rates"("tenantId", "countryCode", "effectiveFrom" DESC, "effectiveTo", "id");

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

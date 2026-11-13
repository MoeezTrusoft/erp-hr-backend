ALTER TABLE "Employee" ADD COLUMN "payrollOffice" VARCHAR(100), ADD COLUMN "attendanceInputMode" TEXT NOT NULL DEFAULT 'DEVICE';
ALTER TABLE "Employee" ADD CONSTRAINT "employee_attendance_input_mode" CHECK ("attendanceInputMode" IN ('DEVICE','MANUAL_MONTHLY'));
ALTER TABLE "payroll_payslips" ADD COLUMN "payrollOffice" VARCHAR(100), ADD COLUMN "attendanceInputMode" TEXT NOT NULL DEFAULT 'DEVICE', ADD COLUMN "payableDays" DECIMAL(5,2);
ALTER TABLE "attendance_anomalies" ADD COLUMN "approvalPolicy" TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "attendance_anomalies" ADD CONSTRAINT "anomaly_approval_policy" CHECK ("approvalPolicy" IN ('STANDARD','HR_MANAGEMENT'));
CREATE TABLE "monthly_payroll_attendance" (
 "id" SERIAL PRIMARY KEY, "tenantId" UUID NOT NULL, "employeeId" INTEGER NOT NULL REFERENCES "Employee"("id"),
 "month" VARCHAR(7) NOT NULL CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 "payableDays" DECIMAL(5,2) NOT NULL CHECK ("payableDays" >= 0 AND "payableDays" <= 31 AND mod("payableDays"*2,1)=0),
 "reason" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1, "updatedById" INTEGER NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE ("tenantId","employeeId","month")
);
CREATE INDEX "monthly_payroll_attendance_tenantId_month_idx" ON "monthly_payroll_attendance"("tenantId","month");

GRANT SELECT, INSERT, UPDATE, DELETE ON "monthly_payroll_attendance" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "monthly_payroll_attendance_id_seq" TO hr_app;
ALTER TABLE "monthly_payroll_attendance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "monthly_payroll_attendance" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "monthly_payroll_attendance"
 USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
 WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

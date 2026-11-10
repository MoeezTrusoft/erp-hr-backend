-- An approved reimbursement claim is paid through payroll: the run that reserves it, and its payslip. The claim becomes
-- PAID when that run is finalised.
ALTER TABLE reimbursement_claims ADD COLUMN IF NOT EXISTS "payrollRunId" integer;
ALTER TABLE reimbursement_claims ADD COLUMN IF NOT EXISTS "payslipId" integer;
CREATE INDEX IF NOT EXISTS reimbursement_claims_pay_idx ON reimbursement_claims ("tenantId", status, "payrollRunId");

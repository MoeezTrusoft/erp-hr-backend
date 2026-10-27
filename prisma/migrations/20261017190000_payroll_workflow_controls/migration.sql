-- Existing repayments were posted by the legacy processor. Never repost them.
-- The migration owner is subject to FORCE RLS in production. Use the trusted
-- system context only for this transaction, including the historical backfill.
BEGIN;
SELECT set_config('app.tenant_bypass', 'on', true);
ALTER TABLE "loan_repayments" ADD COLUMN "settledAt" TIMESTAMP(3);
UPDATE "loan_repayments" SET "settledAt" = "deductedAt";
ALTER TABLE "payroll_runs" ADD COLUMN "calculationConfigVersion" INTEGER;
ALTER TABLE "payroll_payslips" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "payroll_payslips" ADD COLUMN "paymentReference" TEXT;
ALTER TABLE "payroll_payslips" ADD COLUMN "paymentEvidence" JSONB;
DROP INDEX IF EXISTS "payroll_runs_tenantId_periodStart_periodEnd_key";
CREATE UNIQUE INDEX "payroll_runs_live_period_key" ON "payroll_runs"("tenantId","periodStart","periodEnd") WHERE status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS "payroll_runs_tenantId_periodStart_periodEnd_idx" ON "payroll_runs"("tenantId","periodStart","periodEnd");
COMMIT;

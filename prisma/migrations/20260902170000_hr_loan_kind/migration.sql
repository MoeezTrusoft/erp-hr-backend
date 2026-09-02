-- HR-PAYROLL-ADVANCE-01 — salary advance as a discriminated loan.
--
-- "Salary advance" existed nowhere: no model, no service, no field. Functionally
-- it is a loan with tenureMonths=1 and interestRatePct=0, so instead of a
-- parallel module it becomes a discriminator on "loans". Every existing row is a
-- real loan, hence DEFAULT 'LOAN' and NOT NULL — the backfill is the default.
DO $$ BEGIN
    CREATE TYPE "LoanKind" AS ENUM ('LOAN', 'ADVANCE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "kind" "LoanKind" NOT NULL DEFAULT 'LOAN';

-- Advances and loans are reported separately, so the KPI/list predicates filter
-- on kind alongside status.
CREATE INDEX IF NOT EXISTS "loans_tenantId_kind_status_idx" ON "loans" ("tenantId", "kind", "status");

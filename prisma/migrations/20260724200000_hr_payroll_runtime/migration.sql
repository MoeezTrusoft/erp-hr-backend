-- Payroll runtime (Payroll-This-Month + My-Payslip) + Claims & Reimbursements.
-- Additive: enum extensions, payslip approval/hold + claim fields, and 4 new
-- tables (claim_items, claim_approvals, claim_information, payslip_questions).
-- Applied per-statement (ALTER TYPE ADD VALUE cannot run in a tx with same-tx use);
-- every statement is idempotent.

-- ── Enum extensions ─────────────────────────────────────────────────────────
ALTER TYPE "PayslipStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "PayslipStatus" ADD VALUE IF NOT EXISTS 'HOLD';
ALTER TYPE "ReimbursementStatus" ADD VALUE IF NOT EXISTS 'NEEDS_INFO';
ALTER TYPE "ReimbursementStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN';

-- ── New enums ───────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "ClaimApprovalStatus" AS ENUM ('PENDING','APPROVED','REJECTED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ClaimInfoStatus" AS ENUM ('PENDING','RESPONDED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "PayslipQuestionStatus" AS ENUM ('OPEN','ANSWERED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── PayrollPayslip: bulk-action audit ───────────────────────────────────────
ALTER TABLE "payroll_payslips"
  ADD COLUMN IF NOT EXISTS "approvedById" INTEGER,
  ADD COLUMN IF NOT EXISTS "approvedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "holdReason"   TEXT;

-- ── ReimbursementClaim: description + reject reason ─────────────────────────
ALTER TABLE "reimbursement_claims"
  ADD COLUMN IF NOT EXISTS "description"    TEXT,
  ADD COLUMN IF NOT EXISTS "rejectedReason" TEXT;

-- ── claim_items ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "claim_items" (
  "id"          SERIAL PRIMARY KEY,
  "claimId"     INTEGER NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "amount"      DOUBLE PRECISION NOT NULL,
  "mediaId"     INTEGER,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"    UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "claim_items_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "reimbursement_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "claim_items_tenantId_idx" ON "claim_items"("tenantId");
CREATE INDEX IF NOT EXISTS "claim_items_claimId_idx" ON "claim_items"("claimId");

-- ── claim_approvals ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "claim_approvals" (
  "id"         SERIAL PRIMARY KEY,
  "claimId"    INTEGER NOT NULL,
  "level"      INTEGER NOT NULL,
  "role"       TEXT,
  "approverId" INTEGER,
  "status"     "ClaimApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "comments"   TEXT,
  "decidedAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"   UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "claim_approvals_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "reimbursement_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "claim_approvals_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "claim_approvals_tenantId_idx" ON "claim_approvals"("tenantId");
CREATE INDEX IF NOT EXISTS "claim_approvals_claimId_idx" ON "claim_approvals"("claimId");

-- ── claim_information ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "claim_information" (
  "id"            SERIAL PRIMARY KEY,
  "claimId"       INTEGER NOT NULL,
  "requestedById" INTEGER,
  "question"      TEXT NOT NULL,
  "response"      TEXT,
  "status"        "ClaimInfoStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt"   TIMESTAMP(3),
  "tenantId"      UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "claim_information_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "reimbursement_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "claim_information_tenantId_idx" ON "claim_information"("tenantId");
CREATE INDEX IF NOT EXISTS "claim_information_claimId_idx" ON "claim_information"("claimId");

-- ── payslip_questions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payslip_questions" (
  "id"            SERIAL PRIMARY KEY,
  "payslipId"     INTEGER NOT NULL,
  "employeeId"    INTEGER NOT NULL,
  "question"      TEXT NOT NULL,
  "status"        "PayslipQuestionStatus" NOT NULL DEFAULT 'OPEN',
  "response"      TEXT,
  "respondedById" INTEGER,
  "respondedAt"   TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"      UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "payslip_questions_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "payroll_payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "payslip_questions_tenantId_idx" ON "payslip_questions"("tenantId");
CREATE INDEX IF NOT EXISTS "payslip_questions_payslipId_idx" ON "payslip_questions"("payslipId");
CREATE INDEX IF NOT EXISTS "payslip_questions_employeeId_idx" ON "payslip_questions"("employeeId");

-- ── FORCE ROW LEVEL SECURITY on the 4 new tables ────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['claim_items','claim_approvals','claim_information','payslip_questions']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hr_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'') '
      'WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'')',
      t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

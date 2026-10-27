-- Phase 4 / decision record §2.5 — the requisition approval matrix.
--
-- Additive throughout: no existing column is altered and nothing is deleted.
-- RequisitionApproval gains two NULLABLE columns rather than a new table, because
-- every decision ever recorded lives in that table and a parallel decision table
-- would fork the audit trail in two.

-- ── The matrix itself ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "requisition_approval_rules" (
    "id"        SERIAL NOT NULL,
    "tenantId"  UUID,
    "stepOrder" INTEGER NOT NULL,
    "role"      TEXT NOT NULL,
    "approverId" INTEGER,
    "minAmount"  DECIMAL(18,4),
    "departmentId" INTEGER,
    "hiringReason" TEXT,
    "requiresDistinctApprover" BOOLEAN NOT NULL DEFAULT true,
    "isActive"  BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- No DEFAULT: Prisma's @updatedAt is maintained by the CLIENT, not the
    -- database, so a DEFAULT here is drift the F-DB-01 chain check catches.
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requisition_approval_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "requisition_approval_rules_tenantId_idx"
    ON "requisition_approval_rules"("tenantId");
CREATE INDEX IF NOT EXISTS "requisition_approval_rules_tenantId_isActive_idx"
    ON "requisition_approval_rules"("tenantId", "isActive");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'requisition_approval_rules_role_check'
    ) THEN
        ALTER TABLE "requisition_approval_rules"
            ADD CONSTRAINT "requisition_approval_rules_role_check"
            CHECK ("role" IN ('HIRING_MANAGER','HR_HEAD','FINANCE','CUSTOM'));
    END IF;
END $$;

-- A step order of 0 or less has no defined evaluation position.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'requisition_approval_rules_step_check'
    ) THEN
        ALTER TABLE "requisition_approval_rules"
            ADD CONSTRAINT "requisition_approval_rules_step_check"
            CHECK ("stepOrder" >= 1);
    END IF;
END $$;

-- A negative amount threshold would make the step apply to every requisition
-- including one with no budget at all — a control that always fires is a control
-- nobody reads, and it would be indistinguishable from a misconfiguration.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'requisition_approval_rules_min_amount_check'
    ) THEN
        ALTER TABLE "requisition_approval_rules"
            ADD CONSTRAINT "requisition_approval_rules_min_amount_check"
            CHECK ("minAmount" IS NULL OR "minAmount" >= 0);
    END IF;
END $$;

-- Two ACTIVE rules cannot share one step position: the chain would have an
-- ambiguous "current step" and the next-pending-step calculation would depend on
-- row order. Scoped to active rows so a deactivated rule can be kept for history
-- beside its replacement.
CREATE UNIQUE INDEX IF NOT EXISTS "requisition_approval_rules_active_step_key"
    ON "requisition_approval_rules" ("tenantId", "stepOrder")
    WHERE "isActive";

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'requisition_approval_rules_approverId_fkey'
    ) THEN
        ALTER TABLE "requisition_approval_rules"
            ADD CONSTRAINT "requisition_approval_rules_approverId_fkey"
            FOREIGN KEY ("approverId") REFERENCES "Employee"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "requisition_approval_rules" TO hr_app;
ALTER TABLE "requisition_approval_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "requisition_approval_rules" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "requisition_approval_rules";
CREATE POLICY tenant_isolation ON "requisition_approval_rules"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

-- ── Decisions learn which step they satisfied ───────────────────────────────
--
-- NULL for every decision taken before the chain existed, which is the honest
-- reading: those were single un-stepped decisions.

ALTER TABLE "RequisitionApproval"
    ADD COLUMN IF NOT EXISTS "stepOrder" INTEGER,
    ADD COLUMN IF NOT EXISTS "role"      TEXT;

-- ── The requisition learns the amount rules are evaluated against ────────────

ALTER TABLE "JobRequisition"
    ADD COLUMN IF NOT EXISTS "budgetedAmount"        DECIMAL(18,4),
    ADD COLUMN IF NOT EXISTS "budgetCurrency"        TEXT,
    ADD COLUMN IF NOT EXISTS "approvalChainSnapshot" JSONB;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'JobRequisition_budgetedAmount_check'
    ) THEN
        ALTER TABLE "JobRequisition"
            ADD CONSTRAINT "JobRequisition_budgetedAmount_check"
            CHECK ("budgetedAmount" IS NULL OR "budgetedAmount" >= 0);
    END IF;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

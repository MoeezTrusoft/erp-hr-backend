-- FR-09 residue — the OFFER approval policy: role-specific approver chains with
-- compensation-exception routing.
--
-- Before this, every offer collected the same hard-coded triple
-- (hiringManager → hrHead → finance). That made "who must sign" a constant in
-- the service rather than a tenant decision, so a band breach could not
-- escalate to Finance on its own merits and Finance review of a small offer
-- could not be waived.
--
-- Additive throughout: Offer APPROVED/approver rows are untouched, and a tenant
-- with no rules keeps the previous chain verbatim (lib/offerApprovalPolicy.js
-- resolves DEFAULT_OFFER_APPROVAL_RULES in that case), so this migration cannot
-- change the meaning of any decision already recorded.

CREATE TABLE IF NOT EXISTS "offer_approval_rules" (
    "id"         SERIAL NOT NULL,
    "tenantId"   UUID,
    "stepOrder"  INTEGER NOT NULL,
    "stage"      TEXT NOT NULL,
    -- Optional named approver ROLE beyond the stage (e.g. "FINANCE_DIRECTOR").
    -- NULL ⇒ the stage's default approver set, exactly as today.
    "role"       TEXT,
    -- Compensation-exception window. NULL/NULL ⇒ the rule always applies.
    "minAmount"  DECIMAL(18,4),
    "maxAmount"  DECIMAL(18,4),
    -- A USD threshold is not a PKR threshold: a rule naming a currency only
    -- applies to offers in that currency.
    "currency"   TEXT,
    "isActive"   BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- No DEFAULT: @updatedAt is maintained by the CLIENT, so a DEFAULT here is
    -- drift the F-DB-01 chain check catches.
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offer_approval_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "offer_approval_rules_tenantId_idx"
    ON "offer_approval_rules"("tenantId");
CREATE INDEX IF NOT EXISTS "offer_approval_rules_tenantId_isActive_idx"
    ON "offer_approval_rules"("tenantId", "isActive");

-- The closed stage vocabulary. A stage outside it would have no approver set,
-- so an offer could be "approved" by a step nobody can satisfy.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'offer_approval_rules_stage_check'
    ) THEN
        ALTER TABLE "offer_approval_rules"
            ADD CONSTRAINT "offer_approval_rules_stage_check"
            CHECK ("stage" IN ('hiringManager', 'hrHead', 'finance'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'offer_approval_rules_step_check'
    ) THEN
        ALTER TABLE "offer_approval_rules"
            ADD CONSTRAINT "offer_approval_rules_step_check"
            CHECK ("stepOrder" >= 1);
    END IF;
END $$;

-- An inverted window would silently filter the rule out of every chain.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'offer_approval_rules_window_check'
    ) THEN
        ALTER TABLE "offer_approval_rules"
            ADD CONSTRAINT "offer_approval_rules_window_check"
            CHECK ("minAmount" IS NULL OR "maxAmount" IS NULL OR "minAmount" <= "maxAmount");
    END IF;
END $$;

-- One ACTIVE rule per stage: two windows for the same stage would make "is this
-- offer approved" depend on which matched first.
CREATE UNIQUE INDEX IF NOT EXISTS "offer_approval_rules_active_stage_key"
    ON "offer_approval_rules" ("tenantId", "stage")
    WHERE "isActive" = true;

-- ── F-DB-05 convention: staged NOT VALID backfill + own RLS policies ───────────

ALTER TABLE "offer_approval_rules" ADD CONSTRAINT "offer_approval_rules_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "offer_approval_rules" TO hr_app;
ALTER TABLE "offer_approval_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "offer_approval_rules" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "offer_approval_rules";
CREATE POLICY tenant_isolation ON "offer_approval_rules"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

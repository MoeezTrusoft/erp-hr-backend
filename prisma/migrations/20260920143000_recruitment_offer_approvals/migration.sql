-- Canonical offer approval state. Existing offers remain pending until
-- explicitly approved through the new approval service.
ALTER TABLE "offers"
  ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING';

CREATE TABLE "offer_approvals" (
  "id" SERIAL NOT NULL,
  "offerId" INTEGER NOT NULL,
  "tenantId" UUID NOT NULL,
  "stage" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "approverId" INTEGER,
  "reason" TEXT,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "offer_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offer_approvals_offerId_fkey"
    FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "offer_approvals_offerId_stage_key" UNIQUE ("offerId", "stage")
);

CREATE INDEX "offer_approvals_tenantId_idx" ON "offer_approvals"("tenantId");
CREATE INDEX "offer_approvals_offerId_tenantId_idx" ON "offer_approvals"("offerId", "tenantId");
-- Tenant-leading: the approval gate always filters by tenant as well.
CREATE INDEX "offers_tenantId_approvalStatus_idx" ON "offers"("tenantId", "approvalStatus");

-- ── App-role grant + FORCE ROW LEVEL SECURITY ───────────────────────────────
-- Fleet convention for a tenant table: hr_app gets the DML grant, the policy is
-- what actually filters by tenant, and the matching RLS_MODELS entry in
-- src/lib/rlsTenant.js is what sets the GUC the policy reads. A grant without a
-- policy is unscoped; a policy without the model entry reads back empty.
GRANT SELECT, INSERT, UPDATE, DELETE ON "offer_approvals" TO hr_app;
ALTER TABLE "offer_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "offer_approvals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "offer_approvals";
CREATE POLICY tenant_isolation ON "offer_approvals"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

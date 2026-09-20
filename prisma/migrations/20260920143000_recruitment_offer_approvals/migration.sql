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

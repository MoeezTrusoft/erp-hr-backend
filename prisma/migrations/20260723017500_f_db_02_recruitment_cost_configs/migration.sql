-- F-DB-02 — fresh replay found recruitment_cost_configs is also referenced by
-- the fleet RLS migration without any predecessor DDL. Match the current model
-- exactly and fail on pre-existing drift rather than silently skipping it.

CREATE TABLE "recruitment_cost_configs" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "period" TEXT NOT NULL DEFAULT 'all',
    "jobAds" INTEGER NOT NULL DEFAULT 0,
    "agencyFees" INTEGER NOT NULL DEFAULT 0,
    "tools" INTEGER NOT NULL DEFAULT 0,
    "other" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_cost_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recruitment_cost_configs_tenantId_period_key"
    ON "recruitment_cost_configs"("tenantId", "period");
CREATE INDEX "recruitment_cost_configs_tenantId_idx"
    ON "recruitment_cost_configs"("tenantId");

-- Recruitment workflow foundation: explicit disposition reasons and immutable stage history.
ALTER TABLE "Application"
  ADD COLUMN "dispositionReason" TEXT,
  ADD COLUMN "holdReason" TEXT,
  ADD COLUMN "withdrawnReason" TEXT;

CREATE TABLE "application_stage_history" (
  "id" SERIAL NOT NULL,
  "applicationId" INTEGER NOT NULL,
  "tenantId" UUID NOT NULL,
  "fromStage" TEXT NOT NULL,
  "toStage" TEXT NOT NULL,
  "reason" TEXT,
  "actorId" INTEGER,
  "source" TEXT NOT NULL DEFAULT 'application',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "application_stage_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "application_stage_history_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "application_stage_history_tenantId_idx"
  ON "application_stage_history"("tenantId");
CREATE INDEX "application_stage_history_applicationId_createdAt_idx"
  ON "application_stage_history"("applicationId", "createdAt");

-- ── App-role grant + FORCE ROW LEVEL SECURITY ───────────────────────────────
-- Fleet convention for a tenant table: hr_app gets the DML grant, the policy is
-- what actually filters by tenant, and the matching RLS_MODELS entry in
-- src/lib/rlsTenant.js is what sets the GUC the policy reads. A grant without a
-- policy is unscoped; a policy without the model entry reads back empty.
GRANT SELECT, INSERT, UPDATE, DELETE ON "application_stage_history" TO hr_app;
ALTER TABLE "application_stage_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_stage_history" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "application_stage_history";
CREATE POLICY tenant_isolation ON "application_stage_history"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

-- Preserve a baseline for existing tenant-scoped applications. Legacy tenantless
-- rows are intentionally excluded; they must be reconciled before interactive
-- workflow enforcement is enabled for those records.
--
-- The bypass GUC is required here: "Application" carries FORCE ROW LEVEL
-- SECURITY, and a migration runs with neither app.tenant_id nor
-- app.tenant_bypass set — so without this the SELECT below sees an EMPTY table
-- and the backfill inserts zero rows while reporting success (the trap recorded
-- in 20260904160000_hr_employment_period). Session-scoped on purpose: a
-- migration runs on its own connection, so it cannot leak into app traffic.
SELECT set_config('app.tenant_bypass', 'on', false);

INSERT INTO "application_stage_history"
  ("applicationId", "tenantId", "fromStage", "toStage", "reason", "source")
SELECT "id", "tenantId", "stage", "stage", 'baseline', 'migration'
FROM "Application"
WHERE "tenantId" IS NOT NULL;

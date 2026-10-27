-- Phase 2.1 — immutable requisition transition history.
--
-- Applications have had an immutable history since 20260920130000
-- (application_stage_history); requisitions had only RequisitionApproval, which
-- records a DECISION and nothing else. Submit, post, reopen and close left no
-- trace, so "who moved this requisition, when, and why" was unanswerable for
-- every transition except approve/reject. This table is that trace.
--
-- Additive: no existing table or column is touched, and nothing is deleted.
-- Tenant-owned and forced under RLS like every other recruitment table.

CREATE TABLE IF NOT EXISTS "requisition_transitions" (
    "id" SERIAL NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "tenantId" UUID,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT,
    "actorId" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'requisition',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requisition_transitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "requisition_transitions_tenantId_idx"
    ON "requisition_transitions"("tenantId");

CREATE INDEX IF NOT EXISTS "requisition_transitions_requisitionId_createdAt_idx"
    ON "requisition_transitions"("requisitionId", "createdAt");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'requisition_transitions_requisitionId_fkey'
    ) THEN
        ALTER TABLE "requisition_transitions"
            ADD CONSTRAINT "requisition_transitions_requisitionId_fkey"
            FOREIGN KEY ("requisitionId") REFERENCES "JobRequisition"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "requisition_transitions" TO hr_app;
ALTER TABLE "requisition_transitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "requisition_transitions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "requisition_transitions";
CREATE POLICY tenant_isolation ON "requisition_transitions"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

-- Preserve a baseline for existing tenant-scoped requisitions so the history is
-- never empty for a live record. The row states the CURRENT status on both sides
-- (there is no earlier state to claim — inventing one would fabricate history)
-- and is labelled `baseline`/'migration' so it can never be mistaken for an
-- operator action.
--
-- The bypass GUC is required here: JobRequisition carries FORCE ROW LEVEL
-- SECURITY, and a migration runs with neither app.tenant_id nor
-- app.tenant_bypass set — so without this the SELECT below sees an EMPTY table
-- and inserts zero rows while reporting success (the trap recorded in
-- 20260904160000_hr_employment_period). Session-scoped on purpose: a migration
-- runs on its own connection, so it cannot leak into app traffic.
SELECT set_config('app.tenant_bypass', 'on', false);

INSERT INTO "requisition_transitions"
  ("requisitionId", "tenantId", "fromStatus", "toStatus", "reason", "source")
SELECT "id", "tenantId", "status", "status", 'baseline', 'migration'
FROM "JobRequisition"
WHERE "tenantId" IS NOT NULL;

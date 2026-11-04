-- MULTI-COMPANY-MIRROR-01 (B-B) — cross-company propagation of attendance
-- resolution requests. Additive only: no new tables, no backfill. Existing rows
-- keep NULL origin columns and false decidedAfterPayrollLock, which is exactly
-- "not part of any mirror group".

ALTER TABLE "attendance_anomalies"
  ADD COLUMN IF NOT EXISTS "originAnomalyId" INTEGER,
  ADD COLUMN IF NOT EXISTS "originTenantId" UUID,
  ADD COLUMN IF NOT EXISTS "mirrorGroupId" UUID,
  ADD COLUMN IF NOT EXISTS "originRaisedByName" TEXT,
  ADD COLUMN IF NOT EXISTS "decidedAfterPayrollLock" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "attendance_anomalies_mirror_group_idx"
  ON "attendance_anomalies" ("mirrorGroupId");

-- Idempotency (R4): one mirror row per origin case per target company, so an
-- outbox retry or a double raise cannot create a second request.
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_anomalies_mirror_key"
  ON "attendance_anomalies" ("originAnomalyId", "tenantId");

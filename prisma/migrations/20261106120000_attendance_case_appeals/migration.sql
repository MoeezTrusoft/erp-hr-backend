-- HR-ATT-APPEAL-01 — a Management-rejected attendance case may be appealed
-- once. Additive only: no new table, no backfill. Existing rows keep NULL,
-- which is exactly "not an appeal"; the rejected original they point at keeps
-- its decision and audit trail and is marked evidenceState = SUPERSEDED, a plain
-- String value, so no enum change is needed.

ALTER TABLE "attendance_anomalies"
  ADD COLUMN IF NOT EXISTS "appealOfAnomalyId" INTEGER;

-- One appeal per rejected case is enforced in the service (a case may be
-- appealed again only after its appeal is itself decided); the index serves the
-- lookup that guard performs.
CREATE INDEX IF NOT EXISTS "attendance_anomalies_appeal_idx"
  ON "attendance_anomalies" ("tenantId", "appealOfAnomalyId");

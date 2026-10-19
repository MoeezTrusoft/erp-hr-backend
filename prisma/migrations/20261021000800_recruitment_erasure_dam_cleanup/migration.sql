-- Phase 10 (remainder) — DAM asset cleanup on erasure.
--
-- Redacting `resumeMediaId` on the candidate row removes HR's POINTER to the
-- resume; the file itself lives in DAM and is owned by DAM. An erasure that stops
-- at the pointer leaves the candidate's resume on the object store, so the
-- erasure path now deletes the asset too and records the outcome here.
--
-- Purely additive: one nullable JSON column on a table that is already
-- tenant-scoped, granted and under FORCE ROW LEVEL SECURITY (migration
-- 20260920180000_recruitment_candidate_privacy). No new table, no new grant, no
-- new policy — a column on an existing RLS table inherits that table's policy.
--
-- Existing rows read back as NULL = "this erasure predates DAM cleanup", which is
-- the truth for them; backfilling a cleanup claim we never made would fabricate an
-- audit trail.

ALTER TABLE "candidate_anonymization_logs"
    ADD COLUMN IF NOT EXISTS "damCleanup" JSONB;

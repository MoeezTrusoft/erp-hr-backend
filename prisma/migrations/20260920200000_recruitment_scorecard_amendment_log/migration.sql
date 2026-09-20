-- Phase 3.4 (remainder) — interview scorecard locking.
--
-- A submitted scorecard is the evidence behind a hiring decision, so it must not
-- be silently re-writable. The service now refuses a changed payload on a
-- submitted row unless the caller supplies an explicit amendment reason, and
-- records every authorised change. The trail lives on the scorecard itself so it
-- needs no new table, no new grant and no new RLS policy — interview_scorecards
-- is already tenant-scoped, granted and under FORCE ROW LEVEL SECURITY.
--
-- Purely additive: both columns are nullable, so existing rows are untouched and
-- read back as "never amended". No backfill is required or wanted — inventing an
-- amendment history for rows that were written before the lock existed would be
-- fabricating an audit trail.

ALTER TABLE "interview_scorecards"
    ADD COLUMN IF NOT EXISTS "amendmentLog" JSONB;

ALTER TABLE "interview_scorecards"
    ADD COLUMN IF NOT EXISTS "lastAmendedAt" TIMESTAMP(3);

-- Phase 7 / decision record §5.1a–5.4 — interview scheduling lifecycle.
--
-- §5.4: a cancel or a reschedule is a first-class, CODED, attributable fact —
-- never a silent mutation of scheduledAt or status. Rows are appended, never
-- edited; the reason vocabulary is the reportable grouping and OTHER demands
-- free-text notes (enforced by lib/interviewScheduling.js; OTHER-without-notes
-- is also refused here at the database for direct writes).
--
-- §5.1a–5.1b: the four calendar columns on interviews are the recruitment
-- LINKAGE to the external event, not a copy of it — the provider stays
-- authoritative for the event itself (§5.1a); these columns only record which
-- external event an interview corresponds to and its sync state, so
-- cancel/update can find what to write/update/cancel without ever owning it.

CREATE TABLE "interview_lifecycle_events" (
    "id"                  SERIAL PRIMARY KEY,
    "interviewId"         INTEGER NOT NULL,
    "tenantId"            UUID,
    "eventType"           TEXT NOT NULL,
    "reasonCode"          TEXT NOT NULL,
    "notes"               TEXT,
    "previousScheduledAt" TIMESTAMP(3),
    "newScheduledAt"      TIMESTAMP(3),
    "actorId"             INTEGER,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "interview_lifecycle_events"
    ADD CONSTRAINT "interview_lifecycle_events_interviewId_fkey"
    FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reads: an interview's lifecycle history (oldest first = the order it
-- happened), tenant-scoped listings.
CREATE INDEX IF NOT EXISTS "interview_lifecycle_events_interviewId_idx"
    ON "interview_lifecycle_events" ("interviewId");
CREATE INDEX IF NOT EXISTS "interview_lifecycle_events_tenantId_idx"
    ON "interview_lifecycle_events" ("tenantId");

-- The closed lifecycle vocabulary. Adding a kind is a constraint change plus
-- lib/interviewScheduling.js — deliberately not a Prisma enum, same reasoning
-- as the screening outcomes: this vocabulary is read by reporting.
ALTER TABLE "interview_lifecycle_events" DROP CONSTRAINT IF EXISTS "interview_lifecycle_events_eventtype_check";
ALTER TABLE "interview_lifecycle_events" ADD CONSTRAINT "interview_lifecycle_events_eventtype_check"
    CHECK ("eventType" IN ('CANCELLED', 'RESCHEDULED', 'RESCHEDULE_REQUESTED'));

-- The §5.4 suggested set, frozen as data. A direct SQL write with an unknown
-- code is a constraint failure; the service refuses earlier with a better error.
ALTER TABLE "interview_lifecycle_events" DROP CONSTRAINT IF EXISTS "interview_lifecycle_events_reasoncode_check";
ALTER TABLE "interview_lifecycle_events" ADD CONSTRAINT "interview_lifecycle_events_reasoncode_check"
    CHECK ("reasonCode" IN ('CANDIDATE_REQUEST', 'INTERVIEWER_CONFLICT', 'BUSINESS_REQUEST',
                            'TECHNICAL_ISSUE', 'LOGISTICS_ISSUE', 'REQUISITION_CLOSED', 'OTHER'));

-- §5.4 — OTHER demands free-text notes, even on a direct write the service
-- never saw. Every other code may carry notes optionally.
ALTER TABLE "interview_lifecycle_events" DROP CONSTRAINT IF EXISTS "interview_lifecycle_events_other_notes_check";
ALTER TABLE "interview_lifecycle_events" ADD CONSTRAINT "interview_lifecycle_events_other_notes_check"
    CHECK ("reasonCode" <> 'OTHER' OR ("notes" IS NOT NULL AND "notes" <> ''));

-- A RESCHEDULED row describes a movement; it must say from where. (The confirm
-- of a candidate request carries previousScheduledAt = null by design — the
-- request row already holds the proposed time — so the from-side is required
-- only when there was a previously scheduled time to move FROM, which the
-- service enforces; the DB cannot distinguish "no previous time" from
-- "forgot to record it" without duplicating service state, so this stays a
-- service-level invariant.)

-- Calendar sync state on interviews. PENDING → SYNCED | FAILED; the column is
-- free text so a new provider state does not require a migration, but the
-- service only ever writes the three documented values.
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "calendarProvider" TEXT;
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "calendarEventId" TEXT;
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "calendarSyncedAt" TIMESTAMP(3);
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "calendarSyncStatus" TEXT;

-- Lookup by external event id within a provider (webhook-driven updates).
-- Named per Prisma's default so the F-DB-01 drift gate sees no rename.
CREATE INDEX IF NOT EXISTS "interviews_calendarProvider_calendarEventId_idx"
    ON "interviews" ("calendarProvider", "calendarEventId");

-- ── F-DB-05 convention: staged NOT VALID backfill + own RLS policy ───────────
-- Nullable-tenantId per the recruitment convention (legacy tenantless rows must
-- stay writable), so this table joins the staged-backfill cohort and carries
-- its own policy in this migration.

ALTER TABLE "interview_lifecycle_events" ADD CONSTRAINT "interview_lifecycle_events_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "interview_lifecycle_events" TO hr_app;
ALTER TABLE "interview_lifecycle_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_lifecycle_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "interview_lifecycle_events";
CREATE POLICY tenant_isolation ON "interview_lifecycle_events"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

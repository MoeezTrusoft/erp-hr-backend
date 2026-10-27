-- Phase 6 / decision record §4.1–4.3 — screening records, disposition reason
-- codes and the requisition shortlist.
--
-- §4.1a: screening is SEPARATE from interview feedback — a recruiter's screen
-- and an interviewer's structured feedback are different facts even when one
-- person holds both roles. One row per screening decision; a re-screen after a
-- hold appends a new row, so the record is a history, not a mutable flag.
--
-- §4.2: reason codes are tenant-owned and versioned. The DEFAULT taxonomy is
-- seeded lazily by the service on first use (NOT here — a migration must not
-- invent a tenant), and a code's MEANING is stable across versions: a new
-- version changes only the label or the notes requirement, so a historic
-- disposition keeps resolving to the same code string.
--
-- §4.3: the shortlist is requisition-specific with no count limit; removal
-- deletes the row because the screening/disposition record is the audit of WHY
-- and the shortlist only tracks WHO is currently marked.

CREATE TABLE "application_screenings" (
    "id"           SERIAL PRIMARY KEY,
    "applicationId" INTEGER NOT NULL,
    "tenantId"     UUID,
    "outcome"      TEXT NOT NULL,
    "reasonCode"   TEXT,
    "notes"        TEXT,
    "criteria"     JSONB,
    "reviewedById" INTEGER,
    "reviewedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "disposition_reason_codes" (
    "id"            SERIAL PRIMARY KEY,
    "tenantId"      UUID,
    "code"          TEXT NOT NULL,
    "label"         TEXT NOT NULL,
    "requiresNotes" BOOLEAN NOT NULL DEFAULT false,
    "version"       INTEGER NOT NULL DEFAULT 1,
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL
);

CREATE TABLE "shortlist_entries" (
    "id"            SERIAL PRIMARY KEY,
    "applicationId" INTEGER NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "tenantId"      UUID,
    "note"          TEXT,
    "addedById"     INTEGER,
    "addedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- FKs. Screenings and shortlist rows cascade with their application (erasure
-- takes them; privacy by design). The shortlist's requisition FK RESTRICTs so
-- a requisition cannot vanish while rows still point at it.
ALTER TABLE "application_screenings"
    ADD CONSTRAINT "application_screenings_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shortlist_entries"
    ADD CONSTRAINT "shortlist_entries_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shortlist_entries"
    ADD CONSTRAINT "shortlist_entries_requisitionId_fkey"
    FOREIGN KEY ("requisitionId") REFERENCES "JobRequisition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reads: screening history per application (newest first), the shortlist per
-- requisition, tenant-scoped admin listings, and reason-code resolution.
CREATE INDEX IF NOT EXISTS "application_screenings_applicationId_reviewedAt_idx"
    ON "application_screenings" ("applicationId", "reviewedAt");
CREATE INDEX IF NOT EXISTS "application_screenings_tenantId_idx"
    ON "application_screenings" ("tenantId");
CREATE INDEX IF NOT EXISTS "disposition_reason_codes_tenantId_isActive_idx"
    ON "disposition_reason_codes" ("tenantId", "isActive");
CREATE INDEX IF NOT EXISTS "shortlist_entries_requisitionId_idx"
    ON "shortlist_entries" ("requisitionId");
CREATE INDEX IF NOT EXISTS "shortlist_entries_tenantId_idx"
    ON "shortlist_entries" ("tenantId");

-- One shortlist row per application (the application already belongs to one
-- requisition, so this also prevents marking the same candidate twice).
CREATE UNIQUE INDEX IF NOT EXISTS "shortlist_entries_applicationId_key"
    ON "shortlist_entries" ("applicationId");

-- A code's MEANING must be stable: the same code may exist in multiple
-- versions, but within one version it is unique per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "disposition_reason_codes_tenantId_code_version_key"
    ON "disposition_reason_codes" ("tenantId", "code", "version");

-- The closed outcome vocabulary. Adding an outcome is a constraint change plus
-- the lib list — deliberately NOT a Prisma enum, same reasoning as the posting
-- channels and the question types: this vocabulary is read by reporting.
ALTER TABLE "application_screenings" DROP CONSTRAINT IF EXISTS "application_screenings_outcome_check";
ALTER TABLE "application_screenings" ADD CONSTRAINT "application_screenings_outcome_check"
    CHECK ("outcome" IN ('ADVANCE', 'REJECT', 'HOLD'));

-- §4.1 — a non-ADVANCE screening MUST carry a reason code; an ADVANCE must not
-- (advancing needs no justification, and a reason on an advance would read as
-- a rejection in any report that joins on reasonCode).
ALTER TABLE "application_screenings" DROP CONSTRAINT IF EXISTS "application_screenings_reason_check";
ALTER TABLE "application_screenings" ADD CONSTRAINT "application_screenings_reason_check"
    CHECK (("outcome" = 'ADVANCE' AND "reasonCode" IS NULL)
        OR ("outcome" <> 'ADVANCE' AND "reasonCode" IS NOT NULL));

-- A reason code's MEANING must be stable: the same code may exist in multiple
-- versions, but within one version it is unique per tenant. (The composite
-- unique above; declared here as the migration's statement of intent.)

-- ── F-DB-05 convention: staged NOT VALID backfill + own RLS policies ────────
-- All three tables carry the nullable-tenantId convention of every recruitment
-- table (legacy tenantless rows must stay writable), so they join the staged-
-- backfill cohort and carry their own policies in this migration.

ALTER TABLE "application_screenings" ADD CONSTRAINT "application_screenings_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "disposition_reason_codes" ADD CONSTRAINT "disposition_reason_codes_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "shortlist_entries" ADD CONSTRAINT "shortlist_entries_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "application_screenings" TO hr_app;
ALTER TABLE "application_screenings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_screenings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "application_screenings";
CREATE POLICY tenant_isolation ON "application_screenings"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "disposition_reason_codes" TO hr_app;
ALTER TABLE "disposition_reason_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "disposition_reason_codes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "disposition_reason_codes";
CREATE POLICY tenant_isolation ON "disposition_reason_codes"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "shortlist_entries" TO hr_app;
ALTER TABLE "shortlist_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shortlist_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "shortlist_entries";
CREATE POLICY tenant_isolation ON "shortlist_entries"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

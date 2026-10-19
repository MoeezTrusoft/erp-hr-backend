-- Phase 5 / FR-04.07 — SAVE-AND-RETURN DRAFTS.
--
-- The spec's application flow is Personal Information → Resume/Documents →
-- Additional Questions → Review & Submit, and it requires "save-and-return-
-- later after email verification". A half-finished form therefore needs a real
-- persistence point, not browser storage: this table holds ONE draft per
-- candidate per requisition (a candidate who re-opens the form gets their own
-- draft back, never someone else's).
--
-- ANTI-ENUMERATION (§3.4, applied to this surface): the draft is keyed to the
-- CANDIDATE, not the email — lookups go draft→token→candidate, and every
-- "cannot load" outcome renders the same response on the wire (the route owns
-- the uniform body). The token itself follows the §3.2 pattern: the row stores
-- sha256(token), the raw token exists only in the emailed link, and saving a
-- new draft replaces the previous token (the old link dies).
--
-- The draft payload is stored VERBATIM (validated shape, unvalidated content):
-- the recruiter's question set can change while a candidate has a draft open,
-- so answers are re-validated against the CURRENT questions at final submit —
-- exactly the same gate a fresh application hits. PII never rides the resume
-- link: the link is a status-link-class token to the candidate's OWN draft.
--
-- Retention: drafts carry their own 30-day clock from last update; the sweep
-- lives in lib/draftExpiry.js. Anonymization of the owning candidate also
-- purges the draft (the erasure must not leave a re-identifiable form behind).

CREATE TABLE "application_drafts" (
    "id"          SERIAL PRIMARY KEY,
    "candidateId" INTEGER NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "payload"     JSONB NOT NULL,
    "resumeMediaId" INTEGER,
    "tokenHash"   TEXT NOT NULL,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId"    UUID
);

ALTER TABLE "application_drafts"
    ADD CONSTRAINT "application_drafts_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ONE draft per candidate per requisition: re-saving overwrites.
CREATE UNIQUE INDEX IF NOT EXISTS "application_drafts_candidate_requisition_key"
    ON "application_drafts" ("candidateId", "requisitionId");
-- The resume-link lookup is by token hash.
CREATE UNIQUE INDEX IF NOT EXISTS "application_drafts_tokenHash_key"
    ON "application_drafts" ("tokenHash");
CREATE INDEX IF NOT EXISTS "application_drafts_tenantId_idx"
    ON "application_drafts" ("tenantId");
-- The expiry sweep's lookup.
CREATE INDEX IF NOT EXISTS "application_drafts_expiresAt_idx"
    ON "application_drafts" ("expiresAt");

-- ── F-DB-05 convention: staged NOT VALID backfill + own RLS policy ───────────
ALTER TABLE "application_drafts" ADD CONSTRAINT "application_drafts_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "application_drafts" TO hr_app;
ALTER TABLE "application_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_drafts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "application_drafts";
CREATE POLICY tenant_isolation ON "application_drafts"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

-- Phase 5 / decision record §3.2 — candidate EMAIL VERIFICATION (magic links).
--
-- The portal reconciles a returning candidate onto their existing row and a new
-- submitter gets a fresh one; neither proves the mailbox is theirs. This table
-- is the verification half: a random one-time token is issued when a portal
-- application names an email, the token is emailed TO that address, and
-- presenting it back proves the mailbox owner saw the mail. The candidate's
-- verified state lands on `candidates.emailVerifiedAt` (this migration).
--
-- Token handling: the RAW token exists only in the email body. The row stores
-- sha256(token) — a DB leak yields hashes, not usable links. One row per
-- candidate per purpose; re-issuing replaces the previous unconsumed token so
-- an old link dies when a new one is minted. No password is ever set: §3.2 is
-- proof-of-mailbox, not an account system.
--
-- Purpose vocabulary: APPLY_VERIFICATION (a portal application triggered it —
-- §3.2) — and nothing else today; adding a purpose is a constraint change, not
-- a silent write, same convention as the packet docClass.

CREATE TABLE "candidate_email_verifications" (
    "id"          SERIAL PRIMARY KEY,
    "candidateId" INTEGER NOT NULL,
    "email"       TEXT NOT NULL,
    "tokenHash"   TEXT NOT NULL,
    "purpose"     TEXT NOT NULL,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "consumedAt"  TIMESTAMP(3),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId"    UUID
);

ALTER TABLE "candidate_email_verifications"
    ADD CONSTRAINT "candidate_email_verifications_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The portal verifies by presenting the token; the lookup is by hash.
CREATE UNIQUE INDEX IF NOT EXISTS "candidate_email_verifications_tokenHash_key"
    ON "candidate_email_verifications" ("tokenHash");
CREATE INDEX IF NOT EXISTS "candidate_email_verifications_candidateId_idx"
    ON "candidate_email_verifications" ("candidateId");
CREATE INDEX IF NOT EXISTS "candidate_email_verifications_tenantId_idx"
    ON "candidate_email_verifications" ("tenantId");

ALTER TABLE "candidate_email_verifications" DROP CONSTRAINT IF EXISTS "candidate_email_verifications_purpose_check";
ALTER TABLE "candidate_email_verifications" ADD CONSTRAINT "candidate_email_verifications_purpose_check"
    CHECK ("purpose" IN ('APPLY_VERIFICATION'));

-- ── The candidate-facing verified state (additive, nullable — UNKNOWN for
--    pre-existing rows, same posture as every privacy column). ────────────────
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);

-- ── F-DB-05 convention: staged NOT VALID backfill + own RLS policy ───────────
ALTER TABLE "candidate_email_verifications" ADD CONSTRAINT "candidate_email_verifications_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "candidate_email_verifications" TO hr_app;
ALTER TABLE "candidate_email_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidate_email_verifications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "candidate_email_verifications";
CREATE POLICY tenant_isolation ON "candidate_email_verifications"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

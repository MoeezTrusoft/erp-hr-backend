-- Phase 6 / decision record §4.5a — the resume-parse attempt ledger, plus the
-- candidate-facing parse-state projection.
--
-- The ledger is keyed by the ASSET'S CONTENT HASH (sha-256 of the bytes), not
-- the media id: re-uploading an identical file HITS the cache — no second
-- vendor call, no second charge, no parsing drift between attempts (§4.5a).
-- The three-attempts-with-exponential-backoff policy itself lives in
-- lib/parseRetry.js; this table is that policy's memory.
--
-- The Candidate columns are a PROJECTION for the candidate-facing UI ("what
-- happened to my resume"). The authoritative dedupe is the (kind, contentHash)
-- unique; resetting by re-upload resolves through the hash, never by candidate.

CREATE TABLE "resume_parse_attempts" (
    "id"           SERIAL PRIMARY KEY,
    "kind"         TEXT NOT NULL,
    "contentHash"  TEXT NOT NULL,
    "mediaId"      INTEGER,
    "status"       TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError"    TEXT,
    "parsedJson"   JSONB,
    "tenantId"     UUID,
    "startedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL
);

-- One ledger row per (kind, content hash) — the §4.5a idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS "resume_parse_attempts_kind_contentHash_key"
    ON "resume_parse_attempts" ("kind", "contentHash");

CREATE INDEX IF NOT EXISTS "resume_parse_attempts_tenantId_idx"
    ON "resume_parse_attempts" ("tenantId");
-- The requeue sweep: stuck RUNNING rows past their lease, oldest first.
CREATE INDEX IF NOT EXISTS "resume_parse_attempts_status_updatedAt_idx"
    ON "resume_parse_attempts" ("status", "updatedAt");

-- The closed vocabularies. Adding a value is a constraint change plus the lib
-- list — the same reasoning as the other recruitment vocabularies.
ALTER TABLE "resume_parse_attempts" DROP CONSTRAINT IF EXISTS "resume_parse_attempts_kind_check";
ALTER TABLE "resume_parse_attempts" ADD CONSTRAINT "resume_parse_attempts_kind_check"
    CHECK ("kind" IN ('CANDIDATE', 'EMPLOYEE'));
ALTER TABLE "resume_parse_attempts" DROP CONSTRAINT IF EXISTS "resume_parse_attempts_status_check";
ALTER TABLE "resume_parse_attempts" ADD CONSTRAINT "resume_parse_attempts_status_check"
    CHECK ("status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED'));

-- Candidate-facing projection of the parse state (Phase 6 §4.5a).
ALTER TABLE "Candidate" ADD COLUMN "parseStatus" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "parseError" TEXT;
ALTER TABLE "Candidate" ADD COLUMN "parsedAt" TIMESTAMP(3);

-- ── F-DB-05 convention: staged NOT VALID backfill + own RLS policy ──────────

ALTER TABLE "resume_parse_attempts" ADD CONSTRAINT "resume_parse_attempts_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "resume_parse_attempts" TO hr_app;
ALTER TABLE "resume_parse_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resume_parse_attempts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "resume_parse_attempts";
CREATE POLICY tenant_isolation ON "resume_parse_attempts"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

-- D-13 — the resume-parse ledger was unique on (kind, contentHash) alone, so
-- the same file uploaded by two tenants shared one row: the second tenant was
-- served the first tenant's parsed result and its provenance. The cache key now
-- includes the tenant.
--
-- Safe on existing data: rows that were unique on (kind, contentHash) are also
-- unique on (tenantId, kind, contentHash). Nothing is deleted.
DROP INDEX IF EXISTS "resume_parse_attempts_kind_contentHash_key";
CREATE UNIQUE INDEX IF NOT EXISTS "resume_parse_attempts_tenantId_kind_contentHash_key"
  ON "resume_parse_attempts" ("tenantId", "kind", "contentHash");

-- Phase 7 / decision record §5.5–5.5b — tenant-configurable scorecard
-- templates and their attachments.
--
-- The template carries its criteria as JSON (an ordered list of
-- { key, label, weight?, required }): a template evolves without a migration,
-- and the DECISIONS (equal weighting as default, required-criteria enforcement)
-- live in lib/scorecardTemplates.js — this file stores structure, not policy.
--
-- §5.5c locking is NOT in this migration: a submitted scorecard already locks
-- through the Phase 3.4 amendment path, and a template must never rewrite the
-- history of the scorecards that cite it. Deactivation is soft for the same
-- reason.

CREATE TABLE "scorecard_templates" (
    "id"          SERIAL PRIMARY KEY,
    "tenantId"    UUID,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "criteria"    JSONB NOT NULL,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL
);

CREATE TABLE "scorecard_template_links" (
    "id"          SERIAL PRIMARY KEY,
    "tenantId"    UUID,
    "templateId"  INTEGER NOT NULL,
    "scopeType"   TEXT NOT NULL,
    "scopeId"     INTEGER,
    "scopeKey"    TEXT,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "scorecard_template_links"
    ADD CONSTRAINT "scorecard_template_links_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "scorecard_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "scorecard_templates_tenantId_idx" ON "scorecard_templates" ("tenantId");
CREATE INDEX IF NOT EXISTS "scorecard_templates_tenantId_isActive_idx" ON "scorecard_templates" ("tenantId", "isActive");
CREATE INDEX IF NOT EXISTS "scorecard_template_links_tenantId_idx" ON "scorecard_template_links" ("tenantId");
CREATE INDEX IF NOT EXISTS "scorecard_template_links_scopeType_scopeId_idx" ON "scorecard_template_links" ("scopeType", "scopeId");
CREATE INDEX IF NOT EXISTS "scorecard_template_links_scopeType_scopeKey_idx" ON "scorecard_template_links" ("scopeType", "scopeKey");

-- One attachment of a given template to a given scope point.
-- Named per Prisma's default so the F-DB-01 drift gate sees no rename.
CREATE UNIQUE INDEX IF NOT EXISTS "scorecard_template_links_templateId_scopeType_scopeId_scope_key"
    ON "scorecard_template_links" ("templateId", "scopeType", "scopeId", "scopeKey");

-- The closed attachment vocabulary. REQUISITION pins a template to one
-- requisition; STAGE to an interview stage; JOB_FAMILY to a Position (the
-- closest thing to a job family the schema has).
ALTER TABLE "scorecard_template_links" DROP CONSTRAINT IF EXISTS "scorecard_template_links_scoptype_check";
ALTER TABLE "scorecard_template_links" ADD CONSTRAINT "scorecard_template_links_scoptype_check"
    CHECK ("scopeType" IN ('REQUISITION', 'STAGE', 'JOB_FAMILY'));

-- REQUISITION and JOB_FAMILY point at a row (scopeId); STAGE is a vocabulary
-- key (scopeKey). Enforce the pairing so a link can never be half-addressed.
ALTER TABLE "scorecard_template_links" DROP CONSTRAINT IF EXISTS "scorecard_template_links_scope_addressing_check";
ALTER TABLE "scorecard_template_links" ADD CONSTRAINT "scorecard_template_links_scope_addressing_check"
    CHECK (
        ("scopeType" IN ('REQUISITION', 'JOB_FAMILY') AND "scopeId" IS NOT NULL AND "scopeKey" IS NULL)
        OR ("scopeType" = 'STAGE' AND "scopeKey" IS NOT NULL AND "scopeId" IS NULL)
    );

-- ── F-DB-05 convention: staged NOT VALID backfill + own RLS policies ───────────

ALTER TABLE "scorecard_templates" ADD CONSTRAINT "scorecard_templates_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;
ALTER TABLE "scorecard_template_links" ADD CONSTRAINT "scorecard_template_links_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "scorecard_templates" TO hr_app;
ALTER TABLE "scorecard_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scorecard_templates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "scorecard_templates";
CREATE POLICY tenant_isolation ON "scorecard_templates"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "scorecard_template_links" TO hr_app;
ALTER TABLE "scorecard_template_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scorecard_template_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "scorecard_template_links";
CREATE POLICY tenant_isolation ON "scorecard_template_links"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

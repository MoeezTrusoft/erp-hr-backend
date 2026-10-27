-- FR-13 residue — TENANT-CONFIGURABLE ONBOARDING CHECKLIST TEMPLATES.
--
-- A provisioned hire's checklist was always seeded from the fixed baseline in
-- lib/onboardingDefaults.js (a documented default, not tenant policy). This
-- table makes the task set a TENANT-OWNED artefact: each tenant authors its
-- own template(s), marks one active default, and every subsequently provisioned
-- hire is seeded from it. No template configured ⇒ the baseline still applies,
-- so an existing tenant's provisioning behaviour is unchanged.
--
-- `tasks` is JSONB (the task list is display-shaped and never queried by field;
-- the same choice ApplicationScreening.criteria made). The SHAPE is validated by
-- a pure module on write, so an invalid template cannot be stored.

CREATE TABLE "onboarding_checklist_templates" (
    "id"          SERIAL PRIMARY KEY,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "tasks"       JSONB NOT NULL,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "isDefault"   BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId"    UUID
);

-- One template per tenant per name; a rename is an update, not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_checklist_templates_tenant_name_key"
    ON "onboarding_checklist_templates" ("tenantId", "name");
CREATE INDEX IF NOT EXISTS "onboarding_checklist_templates_tenantId_idx"
    ON "onboarding_checklist_templates" ("tenantId");
-- The resolve path asks for the tenant's active default.
CREATE INDEX IF NOT EXISTS "onboarding_checklist_templates_default_idx"
    ON "onboarding_checklist_templates" ("tenantId", "isDefault", "isActive");

-- F-DB-05 convention: staged NOT VALID backfill + own RLS policy.
ALTER TABLE "onboarding_checklist_templates" ADD CONSTRAINT "onboarding_checklist_templates_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "onboarding_checklist_templates" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "onboarding_checklist_templates_id_seq" TO hr_app;
ALTER TABLE "onboarding_checklist_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "onboarding_checklist_templates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "onboarding_checklist_templates";
CREATE POLICY tenant_isolation ON "onboarding_checklist_templates"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

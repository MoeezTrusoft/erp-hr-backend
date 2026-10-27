-- Repair legacy competing defaults deterministically, retaining the most recently edited active default.
UPDATE onboarding_checklist_templates SET "isDefault"=false WHERE "isActive"=false AND "isDefault"=true;
WITH ranked AS (SELECT id,row_number() OVER (PARTITION BY "tenantId" ORDER BY updated_at DESC,id DESC) AS position FROM onboarding_checklist_templates WHERE "isDefault"=true AND "isActive"=true AND "tenantId" IS NOT NULL)
UPDATE onboarding_checklist_templates SET "isDefault"=false WHERE id IN (SELECT id FROM ranked WHERE position>1);
CREATE UNIQUE INDEX onboarding_template_one_active_default ON onboarding_checklist_templates("tenantId") WHERE "isDefault"=true AND "isActive"=true AND "tenantId" IS NOT NULL;

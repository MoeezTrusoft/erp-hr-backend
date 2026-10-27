ALTER TABLE offer_letter_versions ADD COLUMN "templateVersion" integer;
ALTER TABLE offer_letter_versions ADD CONSTRAINT offer_letter_template_policy_fk
 FOREIGN KEY ("tenantId", "templateVersion")
 REFERENCES recruitment_policy_versions ("tenantId", version);
COMMENT ON COLUMN offer_letter_versions."templateVersion" IS 'Immutable company recruitment policy version used for this rendered letter; NULL for uploaded PDFs or the built-in template.';

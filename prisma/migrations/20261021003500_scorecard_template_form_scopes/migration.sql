-- Recruitment Phase 3b — evaluation forms attach to an interview type or a
-- panel role, not only a requisition, stage or job family.
--
-- The Phase 7 CHECKs (20261021002000) allowed REQUISITION / STAGE / JOB_FAMILY
-- only, so an INTERVIEW_TYPE or PANEL_ROLE link failed at the database. Both
-- new scopes are vocabulary keys (scopeKey), addressed like STAGE. The service
-- offers them only with HR_RECRUITMENT_EVALUATION_FORMS on.

ALTER TABLE "scorecard_template_links" DROP CONSTRAINT IF EXISTS "scorecard_template_links_scoptype_check";
ALTER TABLE "scorecard_template_links" ADD CONSTRAINT "scorecard_template_links_scoptype_check"
    CHECK ("scopeType" IN ('REQUISITION', 'STAGE', 'JOB_FAMILY', 'INTERVIEW_TYPE', 'PANEL_ROLE'));

ALTER TABLE "scorecard_template_links" DROP CONSTRAINT IF EXISTS "scorecard_template_links_scope_addressing_check";
ALTER TABLE "scorecard_template_links" ADD CONSTRAINT "scorecard_template_links_scope_addressing_check"
    CHECK (
        ("scopeType" IN ('REQUISITION', 'JOB_FAMILY') AND "scopeId" IS NOT NULL AND "scopeKey" IS NULL)
        OR ("scopeType" IN ('STAGE', 'INTERVIEW_TYPE', 'PANEL_ROLE') AND "scopeKey" IS NOT NULL AND "scopeId" IS NULL)
    );

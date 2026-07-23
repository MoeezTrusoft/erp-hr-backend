-- TEN-2 — extend FORCE ROW LEVEL SECURITY across the HR tenant-owned fleet.
--
-- Rolls the proven bypass-aware pilot pattern onto the remaining 78
-- tenant-owned HR tables (leave / attendance-adjacent / performance / training /
-- recruitment / onboarding / offboarding / time / compliance / benefits / …).
-- Every table already carries a nullable `tenantId` uuid + index (REQ-007 / C.2).
--
-- Data-checked before enabling: skills / leave_policies / regions / holiday_
-- calendars / grade_levels / tax_rates / shift_templates / training_categories
-- all have 0 null-tenant rows (per-tenant config only), so the plain policy
-- hides nothing — NO `OR tenantId IS NULL` carve-out is needed.
--
-- CREATE-STAMP SAFETY NET: `ALTER COLUMN "tenantId" SET DEFAULT hr_current_tenant()`
-- so any INSERT that omits tenantId auto-fills it from the session GUC (which the
-- rlsTenant extension / tenantTransaction sets per op). This makes the 78-table
-- rollout safe without touching every create site. Explicit stamps (scopedData)
-- still win — they pass the same value. Under SYSTEM bypass the default resolves
-- to NULL (no app.tenant_id set) which the bypass clause permits.
--
-- Employee (column `tenant_id`, most-read table) and outbox_events (NOT NULL,
-- infra, dispatcher already bypasses) are deliberately NOT forced here — handled
-- in a dedicated follow-up.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'DashboardLayout',
    'EmployeeMedia',
    'BusinessUnit',
    'GradeLevel',
    'Log',
    'Leave',
    'leave_policies',
    'leave_request_approvals',
    'leave_balances',
    'approval_workflows',
    'approval_workflow_steps',
    'regions',
    'holiday_calendars',
    'holidays',
    'employee_holiday_calendars',
    'overtime_rules',
    'shift_templates',
    'shift_assignments',
    'shift_swap_requests',
    'overtime_requests',
    'work_schedules',
    'Source',
    'ReviewFeedback',
    'Position',
    'JobRequisition',
    'RequisitionApproval',
    'JobPosting',
    'TrainingCategory',
    'TrainingCourse',
    'TrainingEnrollment',
    'PerformanceCycle',
    'PerformanceTemplate',
    'Goal',
    'GoalProgress',
    'GoalAlignment',
    'ReviewReminder',
    'CalibrationSession',
    'RatingAdjustment',
    'tax_rates',
    'Tag',
    'Candidate',
    'candidate_skills',
    'CandidateTag',
    'Application',
    'PerformanceMetric',
    'PerformanceReviewItem',
    'onboarding_checklists',
    'onboarding_sessions',
    'onboarding_tasks',
    'onboarding_documents',
    'onboarding_buddies',
    'onboarding_surveys',
    'interviews',
    'interview_interviewers',
    'interview_scorecards',
    'offers',
    'talent_pools',
    'recruitment_cost_configs',
    'learning_paths',
    'learning_path_courses',
    'learning_path_enrollments',
    'training_sessions',
    'training_session_attendees',
    'certifications',
    'recognitions',
    'skills',
    'employee_skills',
    'employee_lifecycle_events',
    'offboarding_checklists',
    'offboarding_tasks',
    'compliance_checklists',
    'compliance_items',
    'document_expiry_alerts',
    'development_plans',
    'development_plan_items',
    'reimbursement_claims',
    'benefit_plans',
    'employee_benefits'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hr_app', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "tenantId" SET DEFAULT public.hr_current_tenant()', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING ("tenantId" = public.hr_current_tenant() '
      || 'OR current_setting(''app.tenant_bypass'', true) = ''on'') '
      || 'WITH CHECK ("tenantId" = public.hr_current_tenant() '
      || 'OR current_setting(''app.tenant_bypass'', true) = ''on'')',
      t
    );
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

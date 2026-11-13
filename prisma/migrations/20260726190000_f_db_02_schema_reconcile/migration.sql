-- F-DB-02 — forward-only reconciliation from a zero-replayed migration chain
-- to the current Prisma schema. Historical migrations remain unchanged.

ALTER TABLE "Candidate" ADD COLUMN "location" TEXT;
ALTER TABLE "Employee" ADD COLUMN "work_mode" TEXT;
ALTER TABLE "JobRequisition" ADD COLUMN "priority" TEXT, ADD COLUMN "requirements" TEXT;
ALTER TABLE "Position" ADD COLUMN "band" TEXT, ADD COLUMN "requirements" TEXT, ADD COLUMN "responsibilities" TEXT;
ALTER TABLE "interview_interviewers" ADD COLUMN "status" TEXT;
ALTER TABLE "interviews" ADD COLUMN "decision" TEXT;
ALTER TABLE "offers"
  ADD COLUMN "approvals" JSONB,
  ADD COLUMN "compensation" JSONB,
  ADD COLUMN "employmentType" TEXT,
  ADD COLUMN "offerType" TEXT,
  ADD COLUMN "terms" JSONB,
  ADD COLUMN "viewedAt" TIMESTAMP(3);
ALTER TABLE "onboarding_checklists"
  ADD COLUMN "activityLog" JSONB,
  ADD COLUMN "currentStage" TEXT,
  ADD COLUMN "memberAssignments" JSONB,
  ADD COLUMN "preboarding" JSONB,
  ADD COLUMN "readyToCollect" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "template" TEXT;
ALTER TABLE "onboarding_tasks" ADD COLUMN "stage" TEXT;

-- The Prisma models do not declare these database-generated defaults. Remove
-- them explicitly so replayed databases and generated clients share one schema.
ALTER TABLE "Employee" ALTER COLUMN "tenant_id" DROP DEFAULT;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'Application', 'BusinessUnit', 'CalibrationSession', 'Candidate',
    'CandidateTag', 'DashboardLayout', 'EmployeeMedia', 'Goal', 'GoalAlignment',
    'GoalProgress', 'GradeLevel', 'JobPosting', 'JobRequisition', 'Leave', 'Log',
    'PerformanceCycle', 'PerformanceMetric', 'PerformanceReviewItem',
    'PerformanceTemplate', 'Position', 'RatingAdjustment', 'RequisitionApproval',
    'ReviewFeedback', 'ReviewReminder', 'Source', 'Tag', 'TrainingCategory',
    'TrainingCourse', 'TrainingEnrollment', 'approval_workflow_steps',
    'approval_workflows', 'attendance_anomalies', 'benefit_plans',
    'candidate_skills', 'certifications', 'claim_approvals', 'claim_information',
    'claim_items', 'compliance_checklists', 'compliance_items', 'course_lectures',
    'course_outcomes', 'course_reviews', 'course_sections',
    'development_plan_items', 'development_plans', 'document_expiry_alerts',
    'employee_benefits', 'employee_holiday_calendars',
    'employee_lifecycle_events', 'employee_skills', 'holiday_calendars',
    'holidays', 'interview_interviewers', 'interview_scorecards', 'interviews',
    'learning_path_courses', 'learning_path_enrollments', 'learning_paths',
    'leave_balances', 'leave_policies', 'leave_request_approvals',
    'offboarding_checklists', 'offboarding_tasks', 'offers', 'onboarding_buddies',
    'onboarding_checklists', 'onboarding_documents', 'onboarding_feedback',
    'onboarding_sessions', 'onboarding_surveys', 'onboarding_tasks',
    'overtime_requests', 'overtime_rules', 'payroll_approval_matrix',
    'payroll_calendars', 'payroll_config_meta', 'payroll_config_snapshots',
    'payroll_rule_config', 'payslip_questions', 'recognitions',
    'recruitment_cost_configs', 'regions', 'reimbursement_claims',
    'salary_components', 'shift_assignments', 'shift_swap_requests',
    'shift_templates', 'skills', 'talent_pools', 'tax_rates',
    'training_session_attendees', 'training_sessions', 'work_schedules'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "tenantId" DROP DEFAULT', t);
  END LOOP;
END $$;

ALTER TABLE "onboarding_feedback" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "payroll_approval_matrix" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "payroll_calendars" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "payroll_config_meta" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "payroll_rule_config" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "salary_components" ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "attendance_anomalies" DROP CONSTRAINT "attendance_anomalies_employeeId_fkey";
ALTER TABLE "attendance_anomalies"
  ADD CONSTRAINT "attendance_anomalies_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leave_requests" DROP CONSTRAINT "leave_requests_leavePolicyId_fkey";
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_leavePolicyId_fkey"
  FOREIGN KEY ("leavePolicyId") REFERENCES "leave_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "onboarding_feedback" DROP CONSTRAINT "onboarding_feedback_checklistId_fkey";
ALTER TABLE "onboarding_tasks"
  ADD CONSTRAINT "onboarding_tasks_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "onboarding_feedback"
  ADD CONSTRAINT "onboarding_feedback_checklistId_fkey"
  FOREIGN KEY ("checklistId") REFERENCES "onboarding_checklists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "onboarding_feedback"
  ADD CONSTRAINT "onboarding_feedback_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER INDEX "system_account_provisioning_status_nextAttemptAt_claimExpiresAt"
  RENAME TO "system_account_provisioning_status_nextAttemptAt_claimExpir_idx";

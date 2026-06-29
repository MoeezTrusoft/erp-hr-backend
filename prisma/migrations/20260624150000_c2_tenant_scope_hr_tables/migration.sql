-- C.2 / T-P2.2 / T-P2.6 — tenant-scope the REMAINING tenant-bearing HR tables.
--
-- HR-04 tenant-scoped only the 9 payroll-family models (+ Employee, Tag,
-- Candidate, Application, PerformanceMetric via REQ-007). This migration adds
-- the SAME tenant column — `tenantId` UUID, NULLABLE (matching the uuid
-- tenancy: RBAC Company.uuid, the verified service-JWT claim) — to the rest of
-- the tenant-bearing HR fleet (leave / attendance / performance / training /
-- recruitment / onboarding / offboarding / time / compliance / …), one column
-- per table + a btree index for the per-query tenant predicate.
--
-- NULLABLE on purpose: scoping is fail-closed in the service layer (a null
-- tenant matches ONLY null-tenant rows). The column is never coerced to a
-- fabricated tenant.
--
-- BACKFILL: where a row carries an employeeId, tenantId is propagated from the
-- owning Employee.tenant_id (itself backfilled by REQ-007 from the RBAC company
-- id->uuid map). Rows with no employee linkage (or a null-tenant employee) stay
-- NULL — never invented. Dev is mostly empty so this is largely a no-op.

-- ── 1. ADD COLUMN (nullable uuid) ───────────────────────────────────────────
ALTER TABLE "Attendance" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "BusinessUnit" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "CalibrationSession" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "CandidateTag" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "DashboardLayout" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "EmergencyContacts" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "EmployeeMedia" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "Goal" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "GoalAlignment" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "GoalProgress" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "GradeLevel" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "JobPosting" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "JobRequisition" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "Leave" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "Log" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "PerformanceCycle" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "PerformanceReview" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "PerformanceReviewItem" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "PerformanceTemplate" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "Position" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "RatingAdjustment" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "RequisitionApproval" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "ReviewFeedback" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "ReviewReminder" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "Source" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "TimeApproval" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "TimeEntry" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "Timesheet" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "TrainingCategory" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "TrainingCourse" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "TrainingEnrollment" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "approval_workflow_steps" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "approval_workflows" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "certifications" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "compliance_checklists" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "compliance_items" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "development_plan_items" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "development_plans" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "document_expiry_alerts" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "employee_holiday_calendars" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "employee_lifecycle_events" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "employee_skills" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "holiday_calendars" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "holidays" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "interview_interviewers" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "interview_scorecards" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "interviews" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "learning_path_courses" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "learning_path_enrollments" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "learning_paths" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "leave_balances" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "leave_policies" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "leave_request_approvals" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "leave_requests" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "offboarding_checklists" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "offboarding_tasks" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "offers" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "onboarding_buddies" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "onboarding_checklists" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "onboarding_documents" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "onboarding_surveys" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "onboarding_tasks" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "overtime_rules" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "payroll_deductions" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "payroll_earnings" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "regions" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "reimbursement_claims" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "skills" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "talent_pools" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "training_session_attendees" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "training_sessions" ADD COLUMN     "tenantId" UUID;
ALTER TABLE "work_schedules" ADD COLUMN     "tenantId" UUID;

-- ── 2. BACKFILL from the owning Employee (employeeId → Employee.tenant_id) ───
UPDATE "Attendance" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "DashboardLayout" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "Goal" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "JobRequisition" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "Leave" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "Log" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "PerformanceReview" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "TimeEntry" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "Timesheet" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "TrainingEnrollment" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "certifications" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "compliance_items" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "development_plans" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "document_expiry_alerts" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "employee_holiday_calendars" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "employee_lifecycle_events" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "employee_skills" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "interview_interviewers" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "learning_path_enrollments" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "leave_balances" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "leave_requests" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "offboarding_checklists" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "onboarding_checklists" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "onboarding_documents" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "onboarding_surveys" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "reimbursement_claims" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "training_session_attendees" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;
UPDATE "work_schedules" AS t SET "tenantId" = e."tenant_id" FROM "Employee" e WHERE t."employeeId" = e."id" AND e."tenant_id" IS NOT NULL;

-- ── 3. CREATE INDEX (tenant predicate) ──────────────────────────────────────
CREATE INDEX "Attendance_tenantId_idx" ON "Attendance"("tenantId");
CREATE INDEX "BusinessUnit_tenantId_idx" ON "BusinessUnit"("tenantId");
CREATE INDEX "CalibrationSession_tenantId_idx" ON "CalibrationSession"("tenantId");
CREATE INDEX "CandidateTag_tenantId_idx" ON "CandidateTag"("tenantId");
CREATE INDEX "DashboardLayout_tenantId_idx" ON "DashboardLayout"("tenantId");
CREATE INDEX "EmergencyContacts_tenantId_idx" ON "EmergencyContacts"("tenantId");
CREATE INDEX "EmployeeMedia_tenantId_idx" ON "EmployeeMedia"("tenantId");
CREATE INDEX "Goal_tenantId_idx" ON "Goal"("tenantId");
CREATE INDEX "GoalAlignment_tenantId_idx" ON "GoalAlignment"("tenantId");
CREATE INDEX "GoalProgress_tenantId_idx" ON "GoalProgress"("tenantId");
CREATE INDEX "GradeLevel_tenantId_idx" ON "GradeLevel"("tenantId");
CREATE INDEX "JobPosting_tenantId_idx" ON "JobPosting"("tenantId");
CREATE INDEX "JobRequisition_tenantId_idx" ON "JobRequisition"("tenantId");
CREATE INDEX "Leave_tenantId_idx" ON "Leave"("tenantId");
CREATE INDEX "Log_tenantId_idx" ON "Log"("tenantId");
CREATE INDEX "PerformanceCycle_tenantId_idx" ON "PerformanceCycle"("tenantId");
CREATE INDEX "PerformanceReview_tenantId_idx" ON "PerformanceReview"("tenantId");
CREATE INDEX "PerformanceReviewItem_tenantId_idx" ON "PerformanceReviewItem"("tenantId");
CREATE INDEX "PerformanceTemplate_tenantId_idx" ON "PerformanceTemplate"("tenantId");
CREATE INDEX "Position_tenantId_idx" ON "Position"("tenantId");
CREATE INDEX "RatingAdjustment_tenantId_idx" ON "RatingAdjustment"("tenantId");
CREATE INDEX "RequisitionApproval_tenantId_idx" ON "RequisitionApproval"("tenantId");
CREATE INDEX "ReviewFeedback_tenantId_idx" ON "ReviewFeedback"("tenantId");
CREATE INDEX "ReviewReminder_tenantId_idx" ON "ReviewReminder"("tenantId");
CREATE INDEX "Source_tenantId_idx" ON "Source"("tenantId");
CREATE INDEX "TimeApproval_tenantId_idx" ON "TimeApproval"("tenantId");
CREATE INDEX "TimeEntry_tenantId_idx" ON "TimeEntry"("tenantId");
CREATE INDEX "Timesheet_tenantId_idx" ON "Timesheet"("tenantId");
CREATE INDEX "TrainingCategory_tenantId_idx" ON "TrainingCategory"("tenantId");
CREATE INDEX "TrainingCourse_tenantId_idx" ON "TrainingCourse"("tenantId");
CREATE INDEX "TrainingEnrollment_tenantId_idx" ON "TrainingEnrollment"("tenantId");
CREATE INDEX "approval_workflow_steps_tenantId_idx" ON "approval_workflow_steps"("tenantId");
CREATE INDEX "approval_workflows_tenantId_idx" ON "approval_workflows"("tenantId");
CREATE INDEX "certifications_tenantId_idx" ON "certifications"("tenantId");
CREATE INDEX "compliance_checklists_tenantId_idx" ON "compliance_checklists"("tenantId");
CREATE INDEX "compliance_items_tenantId_idx" ON "compliance_items"("tenantId");
CREATE INDEX "development_plan_items_tenantId_idx" ON "development_plan_items"("tenantId");
CREATE INDEX "development_plans_tenantId_idx" ON "development_plans"("tenantId");
CREATE INDEX "document_expiry_alerts_tenantId_idx" ON "document_expiry_alerts"("tenantId");
CREATE INDEX "employee_holiday_calendars_tenantId_idx" ON "employee_holiday_calendars"("tenantId");
CREATE INDEX "employee_lifecycle_events_tenantId_idx" ON "employee_lifecycle_events"("tenantId");
CREATE INDEX "employee_skills_tenantId_idx" ON "employee_skills"("tenantId");
CREATE INDEX "holiday_calendars_tenantId_idx" ON "holiday_calendars"("tenantId");
CREATE INDEX "holidays_tenantId_idx" ON "holidays"("tenantId");
CREATE INDEX "interview_interviewers_tenantId_idx" ON "interview_interviewers"("tenantId");
CREATE INDEX "interview_scorecards_tenantId_idx" ON "interview_scorecards"("tenantId");
CREATE INDEX "interviews_tenantId_idx" ON "interviews"("tenantId");
CREATE INDEX "learning_path_courses_tenantId_idx" ON "learning_path_courses"("tenantId");
CREATE INDEX "learning_path_enrollments_tenantId_idx" ON "learning_path_enrollments"("tenantId");
CREATE INDEX "learning_paths_tenantId_idx" ON "learning_paths"("tenantId");
CREATE INDEX "leave_balances_tenantId_idx" ON "leave_balances"("tenantId");
CREATE INDEX "leave_policies_tenantId_idx" ON "leave_policies"("tenantId");
CREATE INDEX "leave_request_approvals_tenantId_idx" ON "leave_request_approvals"("tenantId");
CREATE INDEX "leave_requests_tenantId_idx" ON "leave_requests"("tenantId");
CREATE INDEX "offboarding_checklists_tenantId_idx" ON "offboarding_checklists"("tenantId");
CREATE INDEX "offboarding_tasks_tenantId_idx" ON "offboarding_tasks"("tenantId");
CREATE INDEX "offers_tenantId_idx" ON "offers"("tenantId");
CREATE INDEX "onboarding_buddies_tenantId_idx" ON "onboarding_buddies"("tenantId");
CREATE INDEX "onboarding_checklists_tenantId_idx" ON "onboarding_checklists"("tenantId");
CREATE INDEX "onboarding_documents_tenantId_idx" ON "onboarding_documents"("tenantId");
CREATE INDEX "onboarding_surveys_tenantId_idx" ON "onboarding_surveys"("tenantId");
CREATE INDEX "onboarding_tasks_tenantId_idx" ON "onboarding_tasks"("tenantId");
CREATE INDEX "overtime_rules_tenantId_idx" ON "overtime_rules"("tenantId");
CREATE INDEX "payroll_deductions_tenantId_idx" ON "payroll_deductions"("tenantId");
CREATE INDEX "payroll_earnings_tenantId_idx" ON "payroll_earnings"("tenantId");
CREATE INDEX "regions_tenantId_idx" ON "regions"("tenantId");
CREATE INDEX "reimbursement_claims_tenantId_idx" ON "reimbursement_claims"("tenantId");
CREATE INDEX "skills_tenantId_idx" ON "skills"("tenantId");
CREATE INDEX "talent_pools_tenantId_idx" ON "talent_pools"("tenantId");
CREATE INDEX "training_session_attendees_tenantId_idx" ON "training_session_attendees"("tenantId");
CREATE INDEX "training_sessions_tenantId_idx" ON "training_sessions"("tenantId");
CREATE INDEX "work_schedules_tenantId_idx" ON "work_schedules"("tenantId");

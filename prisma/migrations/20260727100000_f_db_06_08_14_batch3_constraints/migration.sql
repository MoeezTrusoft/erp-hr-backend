-- DB Batch 3: Float→Decimal, FK indexes, tenant uniques, @db.Text
-- Finding IDs: F-DB-06, F-DB-08, F-DB-14

-- ============================================================
-- 1. Exact money: Float → Decimal  (F-12 / ARCH-01 §5.1)
-- ============================================================

ALTER TABLE "GradeLevel"
  ALTER COLUMN "minSalary" TYPE numeric(18,4),
  ALTER COLUMN "midSalary" TYPE numeric(18,4),
  ALTER COLUMN "maxSalary" TYPE numeric(18,4);

ALTER TABLE "reimbursement_claims"
  ALTER COLUMN "amount" TYPE numeric(18,4);

ALTER TABLE "claim_items"
  ALTER COLUMN "amount" TYPE numeric(18,4);

ALTER TABLE "tax_rates"
  ALTER COLUMN "rate" TYPE numeric(8,6);

ALTER TABLE "payroll_assignments"
  ALTER COLUMN "rate" TYPE numeric(8,6);

ALTER TABLE "payroll_deduction_types"
  ALTER COLUMN "rate" TYPE numeric(8,6);

ALTER TABLE "salary_components"
  ALTER COLUMN "value" TYPE numeric(18,4);

ALTER TABLE "recruitment_cost_configs"
  ALTER COLUMN "jobAds" TYPE numeric(18,4),
  ALTER COLUMN "agencyFees" TYPE numeric(18,4),
  ALTER COLUMN "tools" TYPE numeric(18,4),
  ALTER COLUMN "other" TYPE numeric(18,4);

-- ============================================================
-- 2. Missing FK indexes (F-DB-08)
--    Index name must use the DB table name, not the model name.
-- ============================================================

-- Employee (no @@map, table = "Employee")
CREATE INDEX IF NOT EXISTS "Employee_positionId_idx"              ON "Employee"("positionId");
CREATE INDEX IF NOT EXISTS "Employee_businessUnitId_idx"          ON "Employee"("businessUnitId");
CREATE INDEX IF NOT EXISTS "Employee_gradeLevelId_idx"            ON "Employee"("gradeLevelId");
CREATE INDEX IF NOT EXISTS "Employee_managerId_idx"               ON "Employee"("managerId");
CREATE INDEX IF NOT EXISTS "Employee_reportToId_idx"              ON "Employee"("reportToId");

-- EmergencyContacts (no @@map, table = "EmergencyContacts")
CREATE INDEX IF NOT EXISTS "EmergencyContacts_employee_Id_idx"   ON "EmergencyContacts"("employee_Id");

-- Leave (no @@map, table = "Leave")
CREATE INDEX IF NOT EXISTS "Leave_employeeId_idx"                 ON "Leave"("employeeId");

-- PerformanceReview (no @@map, table = "PerformanceReview")
CREATE INDEX IF NOT EXISTS "PerformanceReview_employeeId_idx"     ON "PerformanceReview"("employeeId");
CREATE INDEX IF NOT EXISTS "PerformanceReview_cycleId_idx"        ON "PerformanceReview"("cycleId");

-- ReviewFeedback (no @@map, table = "ReviewFeedback")
CREATE INDEX IF NOT EXISTS "ReviewFeedback_reviewId_idx"          ON "ReviewFeedback"("reviewId");
CREATE INDEX IF NOT EXISTS "ReviewFeedback_reviewerId_idx"        ON "ReviewFeedback"("reviewerId");

-- JobRequisition (no @@map, table = "JobRequisition")
CREATE INDEX IF NOT EXISTS "JobRequisition_positionId_idx"        ON "JobRequisition"("positionId");
CREATE INDEX IF NOT EXISTS "JobRequisition_requestedById_idx"     ON "JobRequisition"("requestedById");
CREATE INDEX IF NOT EXISTS "JobRequisition_approvedById_idx"      ON "JobRequisition"("approvedById");
CREATE INDEX IF NOT EXISTS "JobRequisition_employeeId_idx"        ON "JobRequisition"("employeeId");

-- RequisitionApproval (no @@map, table = "RequisitionApproval")
CREATE INDEX IF NOT EXISTS "RequisitionApproval_requisitionId_idx" ON "RequisitionApproval"("requisitionId");
CREATE INDEX IF NOT EXISTS "RequisitionApproval_approverId_idx"   ON "RequisitionApproval"("approverId");

-- JobPosting (no @@map, table = "JobPosting")
CREATE INDEX IF NOT EXISTS "JobPosting_requisitionId_idx"         ON "JobPosting"("requisitionId");

-- Application (no @@map, table = "Application")
CREATE INDEX IF NOT EXISTS "Application_candidateId_idx"          ON "Application"("candidateId");
CREATE INDEX IF NOT EXISTS "Application_jobRequisitionId_idx"     ON "Application"("jobRequisitionId");

-- Interview (@@map("interviews"))
CREATE INDEX IF NOT EXISTS "interviews_applicationId_idx"         ON "interviews"("applicationId");

-- Offer (@@map("offers"))
CREATE INDEX IF NOT EXISTS "offers_candidateId_idx"               ON "offers"("candidateId");
CREATE INDEX IF NOT EXISTS "offers_jobRequisitionId_idx"          ON "offers"("jobRequisitionId");

-- TrainingEnrollment (no @@map, table = "TrainingEnrollment")
CREATE INDEX IF NOT EXISTS "TrainingEnrollment_courseId_idx"      ON "TrainingEnrollment"("courseId");
CREATE INDEX IF NOT EXISTS "TrainingEnrollment_employeeId_idx"    ON "TrainingEnrollment"("employeeId");

-- Certification (@@map("certifications"))
CREATE INDEX IF NOT EXISTS "certifications_employeeId_idx"        ON "certifications"("employeeId");
CREATE INDEX IF NOT EXISTS "certifications_courseId_idx"          ON "certifications"("courseId");

-- ReimbursementClaim (@@map("reimbursement_claims"))
CREATE INDEX IF NOT EXISTS "reimbursement_claims_employeeId_idx"  ON "reimbursement_claims"("employeeId");

-- OnboardingChecklist (@@map("onboarding_checklists"))
CREATE INDEX IF NOT EXISTS "onboarding_checklists_employeeId_idx" ON "onboarding_checklists"("employeeId");

-- OffboardingTask (@@map("offboarding_tasks"))
CREATE INDEX IF NOT EXISTS "offboarding_tasks_checklistId_idx"    ON "offboarding_tasks"("checklistId");

-- ComplianceItem (@@map("compliance_items"))
CREATE INDEX IF NOT EXISTS "compliance_items_checklistId_idx"     ON "compliance_items"("checklistId");
CREATE INDEX IF NOT EXISTS "compliance_items_employeeId_idx"      ON "compliance_items"("employeeId");

-- DevelopmentPlanItem (@@map("development_plan_items"))
CREATE INDEX IF NOT EXISTS "development_plan_items_planId_idx"    ON "development_plan_items"("planId");

-- DocumentExpiryAlert (@@map("document_expiry_alerts"))
CREATE INDEX IF NOT EXISTS "document_expiry_alerts_employeeId_idx" ON "document_expiry_alerts"("employeeId");

-- ============================================================
-- 3. Tenant-scoped natural-key uniques  (F-DB-06 / §5.2)
--    Idempotent via DO blocks.
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='BusinessUnit_tenantId_name_key') THEN
    ALTER TABLE "BusinessUnit" ADD CONSTRAINT "BusinessUnit_tenantId_name_key" UNIQUE ("tenantId", "name");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='GradeLevel_tenantId_name_key') THEN
    ALTER TABLE "GradeLevel" ADD CONSTRAINT "GradeLevel_tenantId_name_key" UNIQUE ("tenantId", "name");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='holiday_calendars_tenantId_name_key') THEN
    ALTER TABLE "holiday_calendars" ADD CONSTRAINT "holiday_calendars_tenantId_name_key" UNIQUE ("tenantId", "name");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='overtime_rules_tenantId_name_key') THEN
    ALTER TABLE "overtime_rules" ADD CONSTRAINT "overtime_rules_tenantId_name_key" UNIQUE ("tenantId", "name");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='Source_tenantId_name_key') THEN
    ALTER TABLE "Source" ADD CONSTRAINT "Source_tenantId_name_key" UNIQUE ("tenantId", "name");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='PerformanceCycle_tenantId_name_key') THEN
    ALTER TABLE "PerformanceCycle" ADD CONSTRAINT "PerformanceCycle_tenantId_name_key" UNIQUE ("tenantId", "name");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='PerformanceTemplate_tenantId_name_key') THEN
    ALTER TABLE "PerformanceTemplate" ADD CONSTRAINT "PerformanceTemplate_tenantId_name_key" UNIQUE ("tenantId", "name");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='TrainingCategory_tenantId_name_key') THEN
    ALTER TABLE "TrainingCategory" ADD CONSTRAINT "TrainingCategory_tenantId_name_key" UNIQUE ("tenantId", "name");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='Position_tenantId_title_key') THEN
    ALTER TABLE "Position" ADD CONSTRAINT "Position_tenantId_title_key" UNIQUE ("tenantId", "title");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='compliance_checklists_tenantId_name_key') THEN
    ALTER TABLE "compliance_checklists" ADD CONSTRAINT "compliance_checklists_tenantId_name_key" UNIQUE ("tenantId", "name");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='shift_templates_tenantId_name_key') THEN
    ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_tenantId_name_key" UNIQUE ("tenantId", "name");
  END IF;
END $$;

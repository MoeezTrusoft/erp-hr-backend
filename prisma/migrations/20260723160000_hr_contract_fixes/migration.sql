-- HR contract-fix consolidation (P2 domain fixers reported these).
-- All additive / defaults — no data loss.

-- interviewType: ONSITE + VIDEO are legitimate interview formats callers/FE use.
ALTER TYPE "InterviewType" ADD VALUE IF NOT EXISTS 'ONSITE';
ALTER TYPE "InterviewType" ADD VALUE IF NOT EXISTS 'VIDEO';

-- hr_payroll_deduction_type_create advertises preTax + FE sends it; add the column.
ALTER TABLE "payroll_deduction_types" ADD COLUMN IF NOT EXISTS "preTax" BOOLEAN NOT NULL DEFAULT false;

-- DB-level defaults so the NOT-NULL invariant is DB-guaranteed, not service-only.
ALTER TABLE "onboarding_checklists" ALTER COLUMN "title" SET DEFAULT 'Employee Onboarding';
ALTER TABLE "onboarding_tasks" ALTER COLUMN "assigneeType" SET DEFAULT 'HR';
ALTER TABLE "development_plans" ALTER COLUMN "startDate" SET DEFAULT now();

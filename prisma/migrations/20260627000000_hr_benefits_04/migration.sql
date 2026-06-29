-- HR-BENEFITS-04 — per-employee benefits (health / retirement / allowances).
-- ADDITIVE ONLY: new enums, two new tables, indexes + FKs. No existing column
-- is altered or dropped. Money columns are integer minor units (see money.js).

-- ── enums ───────────────────────────────────────────────────────────────────
CREATE TYPE "BenefitType" AS ENUM ('HEALTH', 'RETIREMENT', 'ALLOWANCE', 'OTHER');
CREATE TYPE "EmployeeBenefitStatus" AS ENUM ('ACTIVE', 'WAIVED', 'TERMINATED');

-- ── benefit_plans ─────────────────────────────────────────────────────────────
CREATE TABLE "benefit_plans" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "name" TEXT NOT NULL,
    "type" "BenefitType" NOT NULL,
    "description" TEXT,
    "employerContributionMinor" INTEGER,
    "employeeContributionMinor" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "benefit_plans_tenantId_idx" ON "benefit_plans"("tenantId");

-- ── employee_benefits ─────────────────────────────────────────────────────────
CREATE TABLE "employee_benefits" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "employeeId" INTEGER NOT NULL,
    "benefitPlanId" INTEGER NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "EmployeeBenefitStatus" NOT NULL DEFAULT 'ACTIVE',
    "electedAmountMinor" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_benefits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "employee_benefits_tenantId_idx" ON "employee_benefits"("tenantId");
CREATE INDEX "employee_benefits_employeeId_idx" ON "employee_benefits"("employeeId");
CREATE INDEX "employee_benefits_benefitPlanId_idx" ON "employee_benefits"("benefitPlanId");

ALTER TABLE "employee_benefits"
    ADD CONSTRAINT "employee_benefits_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employee_benefits"
    ADD CONSTRAINT "employee_benefits_benefitPlanId_fkey"
    FOREIGN KEY ("benefitPlanId") REFERENCES "benefit_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

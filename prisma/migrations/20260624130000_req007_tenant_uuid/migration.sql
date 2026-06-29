-- REQ-007 — tenant identity TYPE migration: Int companyId -> RBAC Company.uuid (String @db.Uuid).
--
-- The access-token tenant claim (tid/tenantId) is now an opaque UUID string (the
-- RBAC Company.uuid), no longer the integer companyId. Every tenant column in
-- this service is converted Int -> uuid, preserving NULLability.
--
-- BACKFILL: existing INT tenantId rows are mapped via the RBAC company id->uuid
-- map (DB erp-rbac, SELECT id, uuid FROM "Company"). RBAC lives in a SEPARATE
-- database, so the map is inlined here as a CASE expression. Dev has exactly one
-- company: id=1 -> 14c350e8-d0bc-4ee9-90c7-dea2b7a7a007. Any row whose old int
-- tenantId is NOT in the map (e.g. legacy 9301 seed data) is UNMAPPABLE and is
-- left NULL (fail-closed; never coerce/invent a tenant).
--
-- Conversion per column: drop dependent index/unique, ALTER TYPE ... USING the
-- CASE backfill, then recreate the index/unique. uuid columns stay nullable.

-- ── Employee.tenant_id ──────────────────────────────────────────────────────
ALTER TABLE "Employee"
  ALTER COLUMN "tenant_id" TYPE UUID
  USING (CASE WHEN "tenant_id" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);

-- ── payroll_runs.tenantId (also re-scopes the period uniqueness) ─────────────
DROP INDEX "payroll_runs_tenantId_idx";
DROP INDEX "payroll_runs_periodStart_periodEnd_key";
ALTER TABLE "payroll_runs"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);
-- REQ-006 follow-up: period uniqueness is now tenant-scoped (a period is unique
-- WITHIN a tenant; two different tenants may own the same period).
CREATE UNIQUE INDEX "payroll_runs_tenantId_periodStart_periodEnd_key" ON "payroll_runs"("tenantId", "periodStart", "periodEnd");
CREATE INDEX "payroll_runs_tenantId_idx" ON "payroll_runs"("tenantId");

-- ── payroll_payslips.tenantId ───────────────────────────────────────────────
DROP INDEX "payroll_payslips_tenantId_idx";
ALTER TABLE "payroll_payslips"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);
CREATE INDEX "payroll_payslips_tenantId_idx" ON "payroll_payslips"("tenantId");

-- ── payroll_earning_types.tenantId ──────────────────────────────────────────
DROP INDEX "payroll_earning_types_tenantId_idx";
ALTER TABLE "payroll_earning_types"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);
CREATE INDEX "payroll_earning_types_tenantId_idx" ON "payroll_earning_types"("tenantId");

-- ── payroll_deduction_types.tenantId ────────────────────────────────────────
DROP INDEX "payroll_deduction_types_tenantId_idx";
ALTER TABLE "payroll_deduction_types"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);
CREATE INDEX "payroll_deduction_types_tenantId_idx" ON "payroll_deduction_types"("tenantId");

-- ── employment_terms.tenantId ───────────────────────────────────────────────
DROP INDEX "employment_terms_tenantId_idx";
ALTER TABLE "employment_terms"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);
CREATE INDEX "employment_terms_tenantId_idx" ON "employment_terms"("tenantId");

-- ── payroll_assignments.tenantId ────────────────────────────────────────────
DROP INDEX "payroll_assignments_tenantId_idx";
ALTER TABLE "payroll_assignments"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);
CREATE INDEX "payroll_assignments_tenantId_idx" ON "payroll_assignments"("tenantId");

-- ── bank_details.tenantId ───────────────────────────────────────────────────
DROP INDEX "bank_details_tenantId_idx";
ALTER TABLE "bank_details"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);
CREATE INDEX "bank_details_tenantId_idx" ON "bank_details"("tenantId");

-- ── tax_rates.tenantId ──────────────────────────────────────────────────────
DROP INDEX "tax_rates_tenantId_idx";
ALTER TABLE "tax_rates"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);
CREATE INDEX "tax_rates_tenantId_idx" ON "tax_rates"("tenantId");

-- ── payroll_audit_logs.tenantId ─────────────────────────────────────────────
DROP INDEX "payroll_audit_logs_tenantId_idx";
ALTER TABLE "payroll_audit_logs"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);
CREATE INDEX "payroll_audit_logs_tenantId_idx" ON "payroll_audit_logs"("tenantId");

-- ── Tag.tenantId (has a unique [tenantId, name]) ────────────────────────────
DROP INDEX "Tag_tenantId_name_key";
ALTER TABLE "Tag"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);
CREATE UNIQUE INDEX "Tag_tenantId_name_key" ON "Tag"("tenantId", "name");

-- ── Candidate.tenantId ──────────────────────────────────────────────────────
ALTER TABLE "Candidate"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);

-- ── Application.tenantId ────────────────────────────────────────────────────
ALTER TABLE "Application"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);

-- ── PerformanceMetric.tenantId ──────────────────────────────────────────────
ALTER TABLE "PerformanceMetric"
  ALTER COLUMN "tenantId" TYPE UUID
  USING (CASE WHEN "tenantId" = 1 THEN '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007'::uuid ELSE NULL END);

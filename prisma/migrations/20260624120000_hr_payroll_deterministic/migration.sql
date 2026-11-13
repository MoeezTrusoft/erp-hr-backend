-- HR-02 / HR-07 (Roadmap T-P4.1) — deterministic, versioned, approval-gated payroll.
--
-- Adds:
--   * PayrollRunStatus.APPROVED — the human-approved state between COMPLETED and
--     FINALIZED. FINALIZE requires a run to have a distinct approver.
--   * payroll_runs.processedBy / approvedBy / approvedAt — separation-of-duties:
--     who ran processing vs. who approved (must differ; no self-approval).
--   * payroll_runs.ruleVersion / ratesEffectiveAt — the versioned tax/rule
--     snapshot the run was computed against, so a run is reproducible against
--     the rates that were in effect (not whatever the TaxRate table holds now).
--   * payroll_payslips.ruleVersion — same version copied onto each payslip so a
--     single payslip is independently reproducible.
--
-- No data is dropped; all new columns are nullable. The APPROVED enum value is
-- appended (Postgres ALTER TYPE ... ADD VALUE), so existing rows are unaffected.

-- ---- enum: add APPROVED + FINALIZED ----
ALTER TYPE "PayrollRunStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "PayrollRunStatus" ADD VALUE IF NOT EXISTS 'FINALIZED';

-- ---- payroll_runs: separation-of-duties + reproducibility columns ----
ALTER TABLE "payroll_runs"
  ADD COLUMN IF NOT EXISTS "processedBy" INTEGER,
  ADD COLUMN IF NOT EXISTS "approvedBy" INTEGER,
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ruleVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "ratesEffectiveAt" TIMESTAMP(3);

-- ---- payroll_payslips: per-payslip rule version ----
ALTER TABLE "payroll_payslips"
  ADD COLUMN IF NOT EXISTS "ruleVersion" TEXT;

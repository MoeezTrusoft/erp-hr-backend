-- HR-PAY-ELIG-01 — is this person on payroll at all?
--
-- Everyone scans on the same device, so the evaluator has been deriving
-- attendance, marking absences and forecasting deductions for people who are
-- not on payroll. That output is meaningless, and it has repeatedly been
-- mistaken for signal: those rows were the largest block left in the August
-- reconciliation gap, against employees HR's workbook has no column for.
--
-- DEFAULT TRUE and NOT NULL on purpose. Attendance is the norm; exclusion is
-- the exception and must be stated. A nullable flag would let a missed backfill
-- read as "unknown", and anything downstream treating unknown as excluded would
-- silently stop paying somebody.
--
-- Additive and reversible: no existing row changes meaning, and dropping the
-- column restores the previous behaviour exactly.

ALTER TABLE "Employee"
    ADD COLUMN IF NOT EXISTS "payroll_included" BOOLEAN NOT NULL DEFAULT true;

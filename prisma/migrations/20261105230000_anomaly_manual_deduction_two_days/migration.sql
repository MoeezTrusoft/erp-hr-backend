-- Management may attach an explicit salary deduction to a rejected attendance
-- case: half, one or two days. Until now the constraint admitted only 0.5 and
-- 1, so a two-day marking could not be stored. The services re-validate the
-- value; the constraint keeps an out-of-range marking out of payroll.
ALTER TABLE attendance_anomalies
  DROP CONSTRAINT IF EXISTS anomaly_manual_deduction_days;
ALTER TABLE attendance_anomalies
  ADD CONSTRAINT anomaly_manual_deduction_days
  CHECK ("manualDeductionDays" IS NULL OR "manualDeductionDays" IN (0.5, 1, 2));

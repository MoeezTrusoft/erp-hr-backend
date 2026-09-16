-- HR-ANOM-DEADLINE-01 — employees have 2 working days to submit an anomaly
-- request. For LATE / MISSING_CHECKIN / MISSING_CHECKOUT the window counts the
-- anomaly day itself as working day 1; for every other type the window starts
-- the day AFTER. Nullable: evaluator-sourced rows are informational for the
-- employee (auto-detected), so they carry no deadline.

ALTER TABLE "attendance_anomalies"
  ADD COLUMN IF NOT EXISTS "requestDeadline" TIMESTAMP(3);

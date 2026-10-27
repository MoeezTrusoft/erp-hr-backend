-- Complete the existing attendance anomaly attribution contract.
-- Nullable columns preserve all historic anomaly rows.
ALTER TABLE "attendance_anomalies"
  ADD COLUMN IF NOT EXISTS "raisedById" INTEGER,
  ADD COLUMN IF NOT EXISTS "raisedByName" TEXT;

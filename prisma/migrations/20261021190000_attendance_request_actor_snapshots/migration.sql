-- These nullable snapshot fields already belong to the application schema.
-- Historical requests retain NULL because their original actor is unknown.
ALTER TABLE "attendance_anomalies"
  ADD COLUMN IF NOT EXISTS "raisedById" INTEGER,
  ADD COLUMN IF NOT EXISTS "raisedByName" TEXT;

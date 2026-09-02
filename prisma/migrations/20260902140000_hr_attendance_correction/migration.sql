-- HR-ATT-CORRECTION-01 — HR/admin manual attendance correction.
--
-- Additive. manually_corrected is the important one: the device roll-up skips
-- any day carrying it, so a correction is not silently overwritten by the next
-- sync. Without that flag the whole feature is pointless.
ALTER TABLE "Attendance" ADD COLUMN IF NOT EXISTS "manually_corrected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Attendance" ADD COLUMN IF NOT EXISTS "corrected_by_id" INTEGER;
ALTER TABLE "Attendance" ADD COLUMN IF NOT EXISTS "corrected_at" TIMESTAMP(3);
ALTER TABLE "Attendance" ADD COLUMN IF NOT EXISTS "correction_reason" TEXT;

CREATE INDEX IF NOT EXISTS "Attendance_manually_corrected_idx"
    ON "Attendance" ("tenantId", "manually_corrected") WHERE "manually_corrected";

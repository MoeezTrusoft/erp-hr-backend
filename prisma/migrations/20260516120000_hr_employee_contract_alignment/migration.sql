-- Align employee/media storage with the frontend-facing HR employee contract.
ALTER TABLE "Employee"
  ALTER COLUMN "personal_contact" TYPE TEXT USING "personal_contact"::TEXT,
  ADD COLUMN IF NOT EXISTS "cover_photo_url" TEXT,
  ADD COLUMN IF NOT EXISTS "cover_photo_media_id" INTEGER;

ALTER TABLE "EmployeeMedia"
  ALTER COLUMN "visibility" DROP DEFAULT,
  ALTER COLUMN "visibility" TYPE TEXT USING CASE WHEN "visibility" THEN 'all' ELSE 'hr_only' END,
  ALTER COLUMN "visibility" SET DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS "file_name" TEXT,
  ADD COLUMN IF NOT EXISTS "mime_type" TEXT,
  ADD COLUMN IF NOT EXISTS "file_size" INTEGER,
  ADD COLUMN IF NOT EXISTS "download_url" TEXT,
  ADD COLUMN IF NOT EXISTS "uploaded_by_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';

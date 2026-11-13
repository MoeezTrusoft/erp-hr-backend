-- Employee bulk-import enrichment:
--   biometric_id   — ZKTeco device enrollment user-ID; attendance punches now
--                    join on this (falls back to employee_code). Separate from
--                    the ERP employee_code.
--   login_password — C4-encrypted (AES-256-GCM envelope) copy of the auto-
--                    generated login password so HR can read it back via
--                    hr_employee_login_password_get. RBAC still holds the hash.
-- Additive, nullable, no data loss. Employee is already FORCE-RLS (no policy
-- change needed for new columns).

ALTER TABLE "Employee"
  ADD COLUMN IF NOT EXISTS "biometric_id"   VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "login_password" TEXT;

CREATE INDEX IF NOT EXISTS "Employee_biometric_id_idx" ON "Employee"("biometric_id");

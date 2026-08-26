-- E3: Backfill Person records for employees with biometric_id but no personId.
--
-- This migration documents the required SQL for manual cross-database execution.
-- Person lives in the RBAC database; Employee lives in the HR database.
-- A Prisma migration cannot span two datasources, so this must be run as a
-- service-level script or manual SQL.

-- Step 1: Create Person records (run against erp-rbac database)
-- INSERT INTO "Person" (id, "biometricId", email, first_name, last_name, "createdAt", "updatedAt")
-- SELECT gen_random_uuid(), e.biometric_id, COALESCE(e.work_email, e.email), e.first_name, e.last_name, now(), now()
-- FROM "Employee" e
-- WHERE e.biometric_id IS NOT NULL
--   AND e."personId" IS NULL
--   AND NOT EXISTS (
--     SELECT 1 FROM "Person" p WHERE p."biometricId" = e.biometric_id
--   );

-- Step 2: Link HR employees to their Person records (run against erp-hr database)
-- This requires reading Person.id back from the RBAC database.
-- Use the backfill service script: scripts/backfill-person-biometric.js
-- or execute via the MCP facade after both databases are updated.

-- UPDATE "Employee" e
-- SET "personId" = p.id
-- FROM "Person" p
-- WHERE e.biometric_id = p."biometricId"
--   AND e."personId" IS NULL;

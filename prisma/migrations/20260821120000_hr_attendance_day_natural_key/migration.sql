-- HR-ATT-IMPORT-01 — give Attendance a real employee-day natural key.
--
-- Attendance carried only indexes, never a unique constraint, so nothing stopped
-- two rows existing for the same employee on the same day. Survivable while rows
-- are created one punch at a time by a human; fatal the moment a bulk importer
-- re-runs, because six years of history silently doubles.
--
-- Two things must be true before the constraint can exist:
--   1. `date` must be a pure calendar day. It is DateTime and defaults to now(),
--      so historical rows carry a time component and two marks on the same day
--      differ in the key. Normalise to midnight first.
--   2. Existing duplicates must be collapsed, keeping the most informative row.
--
-- Applied inside one transaction with ON_ERROR_STOP=1 — a failure rolls back whole.

-- 1. Normalise every stored date to midnight so the DAY is the key.
UPDATE "Attendance"
   SET "date" = date_trunc('day', "date")
 WHERE "date" <> date_trunc('day', "date");

-- 2. Collapse duplicate employee-days. "Most informative" is deliberate, not
--    arbitrary: prefer the row that actually has punches, then the richer
--    status, then the most recently updated. A row carrying check_in/check_out
--    beats a bare ABSENT skeleton written by a nightly job.
WITH ranked AS (
    SELECT "id",
           row_number() OVER (
               PARTITION BY "tenantId", "employeeId", "date"
               ORDER BY (("check_in" IS NOT NULL)::int + ("check_out" IS NOT NULL)::int) DESC,
                        CASE "status"
                            WHEN 'PRESENT'  THEN 4
                            WHEN 'LATE'     THEN 3
                            WHEN 'HALF_DAY' THEN 2
                            ELSE 1
                        END DESC,
                        "updated_at" DESC,
                        "id" DESC
           ) AS rn
      FROM "Attendance"
)
DELETE FROM "Attendance" a
 USING ranked r
 WHERE a."id" = r."id"
   AND r.rn > 1;

-- 3. The natural key the importer upserts on. Tenant-leading so it doubles as
--    the scan path for a per-tenant day lookup.
--
--    NULLS NOT DISTINCT because tenantId is nullable (C.2 fail-closed legacy):
--    without it every un-stamped row counts as unique and the duplicates this
--    migration just removed would walk straight back in.
CREATE UNIQUE INDEX IF NOT EXISTS "Attendance_tenant_employee_day_key"
    ON "Attendance" ("tenantId", "employeeId", "date") NULLS NOT DISTINCT;

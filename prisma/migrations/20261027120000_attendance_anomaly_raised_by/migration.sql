-- TS-ONBEHALF-01 — the filer snapshot on a regularization request.
--
-- `AttendanceAnomaly.raisedById` / `raisedByName` are declared in schema.prisma
-- and are read by the timesheet read model (src/services/timesheetReport.service.js)
-- and by the anomaly serializer (src/services/attendanceAnomaly.service.js), but
-- no migration ever created them: the columns were applied to the fleet database
-- out of band. A database built from migrations alone — the isolated test
-- database, a fresh tenant, CI — therefore fails on every attendance query:
--
--   The column `attendance_anomalies.raisedById` does not exist in the current database.
--
-- Production already carries the columns, so this migration is written to be a
-- no-op there and to create them everywhere else. Types mirror schema.prisma:
-- `raisedById Int?` and `raisedByName String?` (both nullable plain refs — there
-- is deliberately no foreign key, the same pattern as `reviewerId`).
ALTER TABLE "attendance_anomalies"
  ADD COLUMN IF NOT EXISTS "raisedById"   INTEGER,
  ADD COLUMN IF NOT EXISTS "raisedByName" TEXT;

-- T&A-RULE-06 (2026-10-05) — an early CHECKOUT becomes a first-class day
-- status. Both early-checkout bands cost half a day:
--   * checked out BEFORE the half-day mark  -> status HALF_DAY (unchanged)
--   * checked out AFTER  the half-day mark  -> status EARLY_CHECKOUT (new)
-- Additive only. The value is written by the attendance evaluator
-- (attendanceEvaluator.js) and priced by Attendance.day_credit = 0.5.
ALTER TYPE "StatusAttendance" ADD VALUE IF NOT EXISTS 'EARLY_CHECKOUT';

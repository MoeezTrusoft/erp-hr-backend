-- HR-ATT-STATUS-01 — say "not working" instead of leaving a blank.
--
-- StatusAttendance could not express a day off. One was represented by the
-- ABSENCE of an attendance row, which is byte-for-byte identical to a day whose
-- data never arrived: nobody can tell "he was off" from "we lost it". It also
-- forced every cleanup to be a DELETE, each one leaving that same ambiguity
-- behind.
--
-- None of these three is in attendanceDeduction's STATUS_TO_RULE allow-list, so
-- none of them can produce a deduction, and day_credit has no payroll consumer
-- today. They are a statement of fact, not a price.
--
-- Additive only: no existing row changes value, and every existing status
-- keeps its meaning. Postgres cannot drop an enum value, so reversing this
-- means leaving the labels unused — harmless.

ALTER TYPE "StatusAttendance" ADD VALUE IF NOT EXISTS 'WEEKLY_OFF';
ALTER TYPE "StatusAttendance" ADD VALUE IF NOT EXISTS 'HOLIDAY';
ALTER TYPE "StatusAttendance" ADD VALUE IF NOT EXISTS 'ON_LEAVE';

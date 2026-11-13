-- An employee can be tracked for attendance without being paid through payroll.
-- payroll_included=false still removes someone from attendance AND payroll (unchanged);
-- attendance_only=true keeps attendance and removes only payroll.
ALTER TABLE "Employee" ADD COLUMN "attendance_only" BOOLEAN NOT NULL DEFAULT false;

-- A missing-time correction can be filed by HR or the employee's line manager for the employee. The employee stays
-- the owner of the request; the filer is kept so the trail says who asked.
ALTER TABLE attendance_correction_requests ADD COLUMN "filedById" integer REFERENCES "Employee"(id);

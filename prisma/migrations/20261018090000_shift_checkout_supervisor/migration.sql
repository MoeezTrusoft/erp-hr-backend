ALTER TABLE shift_templates
  ADD COLUMN "departmentId" integer,
  ADD COLUMN "supervisorId" integer,
  ADD COLUMN "checkoutCutoffTime" text,
  ADD COLUMN "checkoutCutoffDayOffset" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT shift_department_fk FOREIGN KEY ("departmentId") REFERENCES "BusinessUnit"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT shift_supervisor_fk FOREIGN KEY ("supervisorId") REFERENCES "Employee"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT shift_cutoff_clock CHECK ("checkoutCutoffTime" IS NULL OR "checkoutCutoffTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT shift_cutoff_day CHECK ("checkoutCutoffDayOffset" IN (0,1)),
  ADD CONSTRAINT shift_supervisor_department CHECK ("supervisorId" IS NULL OR "departmentId" IS NOT NULL);
CREATE INDEX shift_department_window_idx ON shift_templates ("tenantId", "departmentId", "fromTime", "toTime");
ALTER TABLE shift_assignments
  ADD COLUMN "checkoutCutoffTime" text,
  ADD COLUMN "checkoutCutoffDayOffset" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT assignment_cutoff_clock CHECK ("checkoutCutoffTime" IS NULL OR "checkoutCutoffTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT assignment_cutoff_day CHECK ("checkoutCutoffDayOffset" IN (0,1));
-- Existing shifts retain their settings; legacy cutoffs are bounded at runtime.
-- No grace settings or employee reporting lines are backfilled by this migration.

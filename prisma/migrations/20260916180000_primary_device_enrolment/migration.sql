-- HR-ATT-PRIMARY-DEVICE-01 — primary biometric device per employee-period.
--
-- Employees increasingly punch across several machines (Shah Hassan: Dalmia
-- 9013 + Johar 9014; M. Yaseen and Amjad Ali punch both sites too). The
-- evaluator already merges every device's punches into one credited day, but
-- the day row carried no record of WHICH device each punch came from, so a
-- check-in at Site A and a check-out at Site B was indistinguishable from a
-- normal single-device day.
--
-- isPrimary marks the enrolment period as the employee's PRIMARY device.
-- Attendance.primary_sn / Attendance.secondary_punches preserve the day's
-- device provenance explicitly: primary punches are the normal case, punches
-- on any other device are counted (and traceable through the raw punch store)
-- rather than silently merged.

ALTER TABLE "employee_device_enrolments"
  ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Attendance"
  ADD COLUMN "primary_sn" VARCHAR(64),
  ADD COLUMN "secondary_punches" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "employee_device_enrolments_primary_idx"
  ON "employee_device_enrolments" ("tenantId", "employeeId", "isPrimary", "effectiveFrom");

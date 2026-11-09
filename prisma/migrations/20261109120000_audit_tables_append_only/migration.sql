-- X4: the two audit tables that could still be edited or emptied by the application role.
-- Every other audit table in this schema is already append-only (HR-4202 style triggers).
--
-- attendance_capture_audit: no foreign keys, so nothing may update or delete a row.
--
-- payroll_audit_logs: its three foreign keys are ON DELETE SET NULL (reprocessing deletes
-- payslips; the GDPR erase path nulls payslipId first). Those cascades are UPDATEs, so a
-- row may change ONLY by one of payrollRunId / payslipId / employeeId going from a value
-- to NULL, with every other column untouched. No row may ever be deleted.
CREATE OR REPLACE FUNCTION audit_row_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HR-4203: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE OR REPLACE FUNCTION payroll_audit_logs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HR-4203: payroll_audit_logs rows are append-only (DELETE refused)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'payrollRunId' - 'payslipId' - 'employeeId')
       IS DISTINCT FROM (to_jsonb(OLD) - 'payrollRunId' - 'payslipId' - 'employeeId')
     OR (NEW."payrollRunId" IS DISTINCT FROM OLD."payrollRunId" AND NEW."payrollRunId" IS NOT NULL)
     OR (NEW."payslipId" IS DISTINCT FROM OLD."payslipId" AND NEW."payslipId" IS NOT NULL)
     OR (NEW."employeeId" IS DISTINCT FROM OLD."employeeId" AND NEW."employeeId" IS NOT NULL) THEN
    RAISE EXCEPTION 'HR-4203: payroll_audit_logs rows are append-only (UPDATE refused)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS attendance_capture_audit_immutable ON attendance_capture_audit;
CREATE TRIGGER attendance_capture_audit_immutable BEFORE UPDATE OR DELETE ON attendance_capture_audit
  FOR EACH ROW EXECUTE FUNCTION audit_row_immutable();

DROP TRIGGER IF EXISTS payroll_audit_logs_append_only ON payroll_audit_logs;
CREATE TRIGGER payroll_audit_logs_append_only BEFORE UPDATE OR DELETE ON payroll_audit_logs
  FOR EACH ROW EXECUTE FUNCTION payroll_audit_logs_guard();

ALTER TABLE attendance_anomalies
 ADD COLUMN "workflowVersion" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "workflowHistory" JSONB NOT NULL DEFAULT '[]',
 ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]',
 ADD COLUMN "manualDeductionDays" DOUBLE PRECISION;
ALTER TABLE attendance_anomalies ADD CONSTRAINT anomaly_manual_deduction_days CHECK ("manualDeductionDays" IS NULL OR "manualDeductionDays" IN (0.5, 1));
CREATE INDEX attendance_anomaly_employee_date_type_idx ON attendance_anomalies ("tenantId", "employeeId", date, type);

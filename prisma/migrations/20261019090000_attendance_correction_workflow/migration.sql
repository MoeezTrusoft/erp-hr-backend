CREATE TABLE attendance_correction_requests (
  id uuid PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  "employeeId" integer NOT NULL REFERENCES "Employee"(id),
  date date NOT NULL,
  "sessionKey" text NOT NULL,
  "checkIn" text,
  "checkOut" text,
  reason text NOT NULL,
  evidence text NOT NULL,
  "reasonCategory" text,
  "evidenceDate" text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  version integer NOT NULL DEFAULT 1,
  "evaluationVersion" integer NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT correction_in_clock CHECK ("checkIn" IS NULL OR "checkIn" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'),
  CONSTRAINT correction_out_clock CHECK ("checkOut" IS NULL OR "checkOut" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$')
);
CREATE INDEX attendance_correction_scope ON attendance_correction_requests ("tenantId", "employeeId", date);
CREATE UNIQUE INDEX attendance_correction_active ON attendance_correction_requests ("tenantId", "employeeId", date, "sessionKey") WHERE status = 'PENDING';
ALTER TABLE attendance_correction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_correction_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_correction_tenant ON attendance_correction_requests USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON attendance_correction_requests FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('ATTENDANCE_CORRECTION','status','APPROVED','REJECTED','employeeId','date,sessionKey,checkIn,checkOut,reason,evidence,reasonCategory,evidenceDate,evaluationVersion,version');

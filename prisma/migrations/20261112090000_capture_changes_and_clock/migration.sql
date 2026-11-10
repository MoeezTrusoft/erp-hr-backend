-- Capture: a manual attendance punch entered by HR is a request that the company's published ATTENDANCE route
-- approves and that is recorded on the final approval (HR_APPROVAL kind CAPTURE_CHANGE). A device with a wrong clock
-- can be sent a time correction (a command the device agent picks up on its next heartbeat).

CREATE TABLE capture_change_requests (
  id uuid PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  reason text NOT NULL,
  "requestedById" integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX capture_change_requests_scope ON capture_change_requests ("tenantId", action, status);

CREATE TABLE attendance_device_commands (
  id uuid PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  "deviceId" uuid NOT NULL,
  sn varchar(64) NOT NULL,
  type text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING',
  detail jsonb,
  "requestedBy" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" timestamp(3),
  "doneAt" timestamp(3)
);
CREATE INDEX attendance_device_commands_open ON attendance_device_commands ("deviceId", state);

-- CAPTURE_CHANGE_SECURITY (the tables above come from the Prisma schema in the isolated test database)
ALTER TABLE capture_change_requests ADD CONSTRAINT capture_change_requester_fk FOREIGN KEY ("requestedById") REFERENCES "Employee"(id), ADD CONSTRAINT capture_change_action CHECK (action IN ('MANUAL_PUNCH')), ADD CONSTRAINT capture_change_status CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN'));
ALTER TABLE capture_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY capture_change_requests_tenant ON capture_change_requests USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON capture_change_requests FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('CAPTURE_CHANGE','status','APPROVED','REJECTED','requestedById','action,payload,reason');

ALTER TABLE attendance_device_commands ADD CONSTRAINT attendance_device_command_type CHECK (type IN ('SET_TIME')), ADD CONSTRAINT attendance_device_command_state CHECK (state IN ('PENDING','SENT','APPLIED','FAILED','CANCELLED'));
ALTER TABLE attendance_device_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_device_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_device_commands_tenant ON attendance_device_commands USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

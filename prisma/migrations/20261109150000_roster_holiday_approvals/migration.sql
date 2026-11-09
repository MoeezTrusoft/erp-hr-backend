-- Roster changes, holiday changes and holiday exemptions are requests that go through the company's published
-- ATTENDANCE approval route and take effect on the final approval (HR_APPROVAL kinds ROSTER_CHANGE,
-- HOLIDAY_CHANGE, HOLIDAY_EXEMPTION). The request rows are guarded like every other approval source: the status can
-- only become APPROVED/REJECTED from the approval engine, and approved content is immutable.

CREATE TABLE roster_change_requests (
  id uuid PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  "employeeId" integer NOT NULL,
  action text NOT NULL,
  "scheduleId" integer,
  payload jsonb NOT NULL,
  reason text NOT NULL,
  "requestedById" integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX roster_change_requests_scope ON roster_change_requests ("tenantId", "employeeId", status);

CREATE TABLE holiday_change_requests (
  id uuid PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  action text NOT NULL,
  "holidayId" integer,
  "holidayCalendarId" integer NOT NULL,
  payload jsonb NOT NULL,
  reason text NOT NULL,
  "requestedById" integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX holiday_change_requests_scope ON holiday_change_requests ("tenantId", "holidayCalendarId", status);

CREATE TABLE holiday_exemption_requests (
  id uuid PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  mode text NOT NULL DEFAULT 'EXEMPT',
  "holidayId" integer NOT NULL,
  "employeeIds" integer[] NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  "requestedById" integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX holiday_exemption_requests_scope ON holiday_exemption_requests ("tenantId", "holidayId", status);

-- The applied exemptions: an exempted employee works that holiday like a normal day.
CREATE TABLE holiday_exemptions (
  id serial PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  "holidayId" integer NOT NULL,
  "employeeId" integer NOT NULL,
  "requestId" uuid,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("holidayId", "employeeId")
);
CREATE INDEX holiday_exemptions_scope ON holiday_exemptions ("tenantId", "employeeId");

-- ROSTER_HOLIDAY_SECURITY (the tables above come from the Prisma schema in the isolated test database)
ALTER TABLE roster_change_requests ADD CONSTRAINT roster_change_employee_fk FOREIGN KEY ("employeeId") REFERENCES "Employee"(id), ADD CONSTRAINT roster_change_requester_fk FOREIGN KEY ("requestedById") REFERENCES "Employee"(id), ADD CONSTRAINT roster_change_action CHECK (action IN ('CREATE','UPDATE','DELETE')), ADD CONSTRAINT roster_change_status CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN'));
ALTER TABLE holiday_change_requests ADD CONSTRAINT holiday_change_requester_fk FOREIGN KEY ("requestedById") REFERENCES "Employee"(id), ADD CONSTRAINT holiday_change_action CHECK (action IN ('CREATE','UPDATE','DELETE')), ADD CONSTRAINT holiday_change_status CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN'));
ALTER TABLE holiday_exemption_requests ADD CONSTRAINT holiday_exemption_holiday_fk FOREIGN KEY ("holidayId") REFERENCES holidays(id) ON DELETE CASCADE, ADD CONSTRAINT holiday_exemption_requester_fk FOREIGN KEY ("requestedById") REFERENCES "Employee"(id), ADD CONSTRAINT holiday_exemption_mode CHECK (mode IN ('EXEMPT','RESTORE')), ADD CONSTRAINT holiday_exemption_status CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')), ADD CONSTRAINT holiday_exemption_size CHECK (cardinality("employeeIds") BETWEEN 1 AND 500);
ALTER TABLE holiday_exemptions ADD CONSTRAINT holiday_exemptions_holiday_fk FOREIGN KEY ("holidayId") REFERENCES holidays(id) ON DELETE CASCADE, ADD CONSTRAINT holiday_exemptions_employee_fk FOREIGN KEY ("employeeId") REFERENCES "Employee"(id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roster_change_requests','holiday_change_requests','holiday_exemption_requests','holiday_exemptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON %I USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')$p$, t || '_tenant', t);
  END LOOP;
END $$;

CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON roster_change_requests FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('ROSTER_CHANGE','status','APPROVED','REJECTED','requestedById','employeeId,action,scheduleId,payload,reason');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON holiday_change_requests FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('HOLIDAY_CHANGE','status','APPROVED','REJECTED','requestedById','action,holidayId,holidayCalendarId,payload,reason');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON holiday_exemption_requests FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('HOLIDAY_EXEMPTION','status','APPROVED','REJECTED','requestedById','mode,holidayId,employeeIds,summary,reason');

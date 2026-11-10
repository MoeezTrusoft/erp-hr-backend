-- Publishing the attendance setup (policy, deduction rules, approval levels) and changing grace rules or grace
-- membership are requests that go through the company's published ATTENDANCE approval route and take effect on the
-- final approval (HR_APPROVAL kind ATTENDANCE_RULE_CHANGE). The request row is guarded like every other approval
-- source: status can only become APPROVED/REJECTED from the approval engine, and approved content is immutable.

CREATE TABLE attendance_rule_change_requests (
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
CREATE INDEX attendance_rule_change_requests_scope ON attendance_rule_change_requests ("tenantId", action, status);

-- ATTENDANCE_RULE_SECURITY (the table above comes from the Prisma schema in the isolated test database)
ALTER TABLE attendance_rule_change_requests ADD CONSTRAINT attendance_rule_change_requester_fk FOREIGN KEY ("requestedById") REFERENCES "Employee"(id), ADD CONSTRAINT attendance_rule_change_action CHECK (action IN ('PUBLISH_SETUP','GRACE_RULE','GRACE_MEMBERSHIP')), ADD CONSTRAINT attendance_rule_change_status CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN'));
ALTER TABLE attendance_rule_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_rule_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_rule_change_requests_tenant ON attendance_rule_change_requests USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON attendance_rule_change_requests FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('ATTENDANCE_RULE_CHANGE','status','APPROVED','REJECTED','requestedById','action,payload,reason');

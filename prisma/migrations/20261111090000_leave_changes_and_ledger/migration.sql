-- Leave: every balance movement is written to a ledger (accrual, leave taken, restore, adjustment, carry-over) with
-- a reason and an idempotency key, so a balance can be explained and an accrual run twice credits once. Leave policy
-- changes, balance adjustments and cancelling approved leave are requests that go through the company's published
-- ATTENDANCE approval route and take effect on final approval (HR_APPROVAL kind LEAVE_CHANGE).

CREATE TABLE leave_balance_ledger (
  id bigserial PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  "employeeId" integer NOT NULL,
  "leavePolicyId" integer NOT NULL,
  kind text NOT NULL,
  days double precision NOT NULL,
  "balanceAfter" double precision NOT NULL,
  "idempotencyKey" text,
  "sourceRef" text,
  reason text,
  "createdById" integer,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX leave_balance_ledger_key ON leave_balance_ledger ("tenantId", "idempotencyKey");
CREATE INDEX leave_balance_ledger_employee ON leave_balance_ledger ("tenantId", "employeeId", "leavePolicyId", "createdAt");

CREATE TABLE leave_change_requests (
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
CREATE INDEX leave_change_requests_scope ON leave_change_requests ("tenantId", action, status);

-- LEAVE_CHANGE_SECURITY (the tables above come from the Prisma schema in the isolated test database)
ALTER TABLE leave_balance_ledger ADD CONSTRAINT leave_balance_ledger_kind CHECK (kind IN ('ACCRUAL','LEAVE_TAKEN','LEAVE_RESTORED','ADJUSTMENT','CARRY_OVER','EXPIRED','OVERDRAFT'));
ALTER TABLE leave_balance_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_balance_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_balance_ledger_tenant ON leave_balance_ledger USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
-- The ledger is append-only: a movement is corrected by a new movement, never edited or deleted.
CREATE FUNCTION leave_balance_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'HR-4210: The leave ledger cannot be edited; post a correcting entry'; END $$;
CREATE TRIGGER leave_balance_ledger_no_change BEFORE UPDATE OR DELETE ON leave_balance_ledger FOR EACH ROW EXECUTE FUNCTION leave_balance_ledger_append_only();

ALTER TABLE leave_change_requests ADD CONSTRAINT leave_change_requester_fk FOREIGN KEY ("requestedById") REFERENCES "Employee"(id), ADD CONSTRAINT leave_change_action CHECK (action IN ('POLICY_CREATE','POLICY_UPDATE','POLICY_DELETE','BALANCE_SET','CANCEL_LEAVE')), ADD CONSTRAINT leave_change_status CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN'));
ALTER TABLE leave_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_change_requests_tenant ON leave_change_requests USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON leave_change_requests FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('LEAVE_CHANGE','status','APPROVED','REJECTED','requestedById','action,payload,reason');

-- Approved leave can be cancelled, but only by an approved LEAVE_CHANGE (action CANCEL_LEAVE) for that very leave.
-- The generic guard stays in force for every other change; a cancel skips it and gets its own check instead.
DROP TRIGGER hr_approval_guard ON "leave_requests";
CREATE TRIGGER hr_approval_guard BEFORE INSERT ON "leave_requests" FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('LEAVE','status','APPROVED','REJECTED','employeeId','startDate,endDate,totalDays,reason,notes,leavePolicyId');
CREATE TRIGGER hr_approval_guard_update BEFORE UPDATE ON "leave_requests" FOR EACH ROW WHEN (NOT (OLD.status = 'APPROVED' AND NEW.status = 'CANCELLED')) EXECUTE FUNCTION hr_approval_source_guard('LEAVE','status','APPROVED','REJECTED','employeeId','startDate,endDate,totalDays,reason,notes,leavePolicyId');
CREATE FUNCTION leave_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."employeeId" IS DISTINCT FROM OLD."employeeId" OR NEW."startDate" IS DISTINCT FROM OLD."startDate" OR NEW."endDate" IS DISTINCT FROM OLD."endDate" OR NEW."totalDays" IS DISTINCT FROM OLD."totalDays" OR NEW."leavePolicyId" IS DISTINCT FROM OLD."leavePolicyId" THEN
  RAISE EXCEPTION 'HR-4204: Approved request content is immutable; create a new request';
 END IF;
 IF current_setting('app.hr_leave_cancel', true) IS DISTINCT FROM 'LEAVE_CANCEL:' || OLD.id::text
    OR NOT EXISTS (SELECT 1 FROM leave_change_requests c JOIN "HrApprovalRequest" r ON r."tenantId" = c."tenantId" AND r.kind = 'LEAVE_CHANGE' AND r."sourceRef" = c.id::text
                   WHERE c."tenantId" = OLD."tenantId" AND c.action = 'CANCEL_LEAVE' AND (c.payload->>'leaveRequestId')::int = OLD.id AND r.stage = 'APPROVED') THEN
  RAISE EXCEPTION 'HR-4201: Cancel approved leave through an approved leave change in HR Approval Centre';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER leave_cancel_guard BEFORE UPDATE ON "leave_requests" FOR EACH ROW WHEN (OLD.status = 'APPROVED' AND NEW.status = 'CANCELLED') EXECUTE FUNCTION leave_cancel_guard();

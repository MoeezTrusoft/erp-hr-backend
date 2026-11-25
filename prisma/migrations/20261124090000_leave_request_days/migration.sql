-- HR-LEAVE-DAYS-01: one row per working date of a leave request (per-day decisions).
CREATE TYPE "LeaveDayDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "leave_request_days" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID,
    "leaveRequestId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "decision" "LeaveDayDecision" NOT NULL DEFAULT 'PENDING',
    "decidedById" INTEGER,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "leave_request_days_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "leave_request_days_tenantId_idx" ON "leave_request_days"("tenantId");
CREATE UNIQUE INDEX "leave_request_days_leaveRequestId_date_key" ON "leave_request_days"("leaveRequestId", "date");
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_request_days" TO hr_app;
GRANT USAGE, SELECT ON SEQUENCE "leave_request_days_id_seq" TO hr_app;
ALTER TABLE "leave_request_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_request_days" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "leave_request_days"
 USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
 WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

-- Decided days of an APPROVED request are immutable, like claim_items (HR-4204). Inserting the PENDING rows
-- on create is allowed: no approval request exists yet, so the guard finds no APPROVED stage.
CREATE TRIGGER hr_approval_line_guard BEFORE INSERT OR UPDATE OR DELETE ON leave_request_days FOR EACH ROW EXECUTE FUNCTION hr_approval_line_guard('LEAVE','leaveRequestId','leaveRequestId,tenantId,date,decision');

-- HR-OT-APPROVAL-01 — overtime through the payroll approval chain.
--
-- OvertimeRequest carried a single approverId, which cannot express "approved in
-- the same order as the payroll approval matrix". Additive: existing rows keep
-- working, they simply start at level 1.
ALTER TABLE "overtime_requests" ADD COLUMN IF NOT EXISTS "currentApprovalLevel" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "overtime_requests" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'MANUAL';

CREATE TABLE IF NOT EXISTS "overtime_request_approvals" (
    "id"                SERIAL PRIMARY KEY,
    "overtimeRequestId" INTEGER NOT NULL REFERENCES "overtime_requests"("id") ON DELETE CASCADE,
    "level"             INTEGER NOT NULL,
    "approverId"        INTEGER NOT NULL REFERENCES "Employee"("id"),
    "approverRole"      TEXT NOT NULL,
    "decision"          "ApprovalDecision" NOT NULL,
    "comments"          TEXT,
    "decidedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId"          UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS "overtime_request_approvals_req_level_key"
    ON "overtime_request_approvals" ("overtimeRequestId", "level");
CREATE INDEX IF NOT EXISTS "overtime_request_approvals_approverId_idx" ON "overtime_request_approvals" ("approverId");
CREATE INDEX IF NOT EXISTS "overtime_request_approvals_tenantId_idx" ON "overtime_request_approvals" ("tenantId");

GRANT SELECT, INSERT, UPDATE, DELETE ON "overtime_request_approvals" TO "erp", "hr_app";
GRANT USAGE, SELECT ON SEQUENCE "overtime_request_approvals_id_seq" TO "erp", "hr_app";

ALTER TABLE "overtime_request_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "overtime_request_approvals" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "overtime_request_approvals";
CREATE POLICY tenant_isolation ON "overtime_request_approvals"
    USING ("tenantId" = hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
    WITH CHECK ("tenantId" = hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

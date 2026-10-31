-- Who did it: the signed-in (RBAC) user behind each payroll audit row. Additive and nullable: rows written
-- before this migration, and system jobs, have no actor. Stamped automatically by lib/auditActor.js.
ALTER TABLE "payroll_audit_logs" ADD COLUMN "actorUserId" INTEGER;
CREATE INDEX "payroll_audit_logs_tenant_action_idx" ON "payroll_audit_logs" ("tenantId", "action");

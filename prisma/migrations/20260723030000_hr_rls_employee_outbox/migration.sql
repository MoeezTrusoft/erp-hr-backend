-- Deferred D1/D2 — extend FORCE ROW LEVEL SECURITY to the two tables held back
-- from the fleet extend: Employee (column tenant_id, snake_case — needs a bespoke
-- policy) and OutboxEvent (tenantId NOT NULL infra table).
--
-- Employee: heavily read via include:{employee}, but every HR entry point (MCP +
-- REST) establishes the tenant ctx, and the reminder/dispatcher jobs run under
-- SYSTEM bypass — same guarantees the 95 already-forced tables rely on. DEFAULT
-- hr_current_tenant() on tenant_id is the create-stamp net (creates run under
-- tenantTransaction / the extension GUC).
-- OutboxEvent: producers stamp tenantId explicitly inside a tenant tx
-- (enqueueHrDomainEvent, fail-closed on missing tenant); the dispatcher drains it
-- under SYSTEM bypass. No DEFAULT (tenantId is NOT NULL and always supplied).

-- ── Employee (tenant_id) ────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "Employee" TO hr_app;
ALTER TABLE "Employee" ALTER COLUMN "tenant_id" SET DEFAULT public.hr_current_tenant();
ALTER TABLE "Employee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Employee" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Employee";
CREATE POLICY tenant_isolation ON "Employee"
  USING ("tenant_id" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenant_id" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

-- ── OutboxEvent (tenantId, NOT NULL) ────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox_events" TO hr_app;
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "outbox_events";
CREATE POLICY tenant_isolation ON "outbox_events"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

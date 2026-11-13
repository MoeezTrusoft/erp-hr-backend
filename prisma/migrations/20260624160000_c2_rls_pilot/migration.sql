-- C.2 / T-P2.6 — RLS PILOT (defense-in-depth).
--
-- Service-layer withTenant() is the primary tenant fence; this migration adds a
-- SECOND, independent fence at the database: Postgres Row-Level Security keyed on
-- a per-session GUC `app.tenant_id`. Even on a LEAKED connection (a query that
-- forgot its tenant predicate, an injection, a stray psql), the database itself
-- refuses to surface another tenant's rows.
--
-- SCOPE: this is a PILOT proving the pattern on a representative set of tables
-- (leave_requests, Attendance, PerformanceReview) — one per family. Rolling RLS
-- across the full tenant-bearing fleet is a follow-on (tracked in the handoff).
--
-- WHY a dedicated role: the app currently connects as a SUPERUSER, and Postgres
-- silently BYPASSES RLS for superusers / table owners. So the pilot also:
--   * FORCEs RLS (applies even to the table owner), and
--   * provisions a NON-superuser, NON-bypassrls `hr_app` login role that the
--     RLS proof connects as — the realistic "leaked app connection".
-- The app's own DATABASE_URL is unchanged here (re-pointing it to hr_app is the
-- follow-on cutover); the pilot proves the policy denies cross-tenant for any
-- non-privileged session.

-- ── 1. dedicated non-privileged application role ────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hr_app') THEN
    -- NOSUPERUSER + NOBYPASSRLS so RLS is actually enforced for this role.
    CREATE ROLE hr_app LOGIN PASSWORD 'hr_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_requests" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Attendance" TO hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "PerformanceReview" TO hr_app;
-- Sequences the role needs for INSERTs (id defaults).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

-- ── 2. helper: the verified tenant for THIS session (GUC app.tenant_id) ─────
-- current_setting(..., true) returns NULL when the GUC is unset (missing_ok),
-- so an un-scoped session matches nothing tenant-bound (fail-closed at the DB).
CREATE OR REPLACE FUNCTION public.hr_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ── 3. enable + FORCE RLS and the tenant policy on each pilot table ──────────
-- Policy: a row is visible/writable iff its tenantId equals the session tenant.
-- (Null-tenant legacy rows are intentionally NOT visible to a tenant-scoped
-- session — fail-closed; they are reachable only by a privileged/bypass role.)

-- leave_requests
ALTER TABLE "leave_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "leave_requests";
CREATE POLICY tenant_isolation ON "leave_requests"
  USING ("tenantId" = public.hr_current_tenant())
  WITH CHECK ("tenantId" = public.hr_current_tenant());

-- Attendance
ALTER TABLE "Attendance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Attendance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Attendance";
CREATE POLICY tenant_isolation ON "Attendance"
  USING ("tenantId" = public.hr_current_tenant())
  WITH CHECK ("tenantId" = public.hr_current_tenant());

-- PerformanceReview
ALTER TABLE "PerformanceReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerformanceReview" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PerformanceReview";
CREATE POLICY tenant_isolation ON "PerformanceReview"
  USING ("tenantId" = public.hr_current_tenant())
  WITH CHECK ("tenantId" = public.hr_current_tenant());

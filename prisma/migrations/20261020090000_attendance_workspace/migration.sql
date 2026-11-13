CREATE TABLE attendance_export_jobs (
  id uuid PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  "ownerUserId" text NOT NULL,
  filters jsonb NOT NULL,
  "employeeIds" jsonb NOT NULL,
  columns jsonb NOT NULL,
  format text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PROCESSING','READY','FAILED','EXPIRED')),
  progress integer NOT NULL DEFAULT 0,
  total integer,
  artifact jsonb,
  "leaseToken" uuid,
  "leaseUntil" timestamp(3),
  error text,
  "generatedAt" timestamp(3),
  "expiresAt" timestamp(3) NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX attendance_export_owner ON attendance_export_jobs ("tenantId", "ownerUserId", "createdAt");
CREATE INDEX attendance_export_queue ON attendance_export_jobs (status, "leaseUntil");
CREATE TABLE attendance_saved_views (
  id uuid PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  "ownerUserId" text NOT NULL,
  name text NOT NULL,
  filters jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX attendance_view_owner ON attendance_saved_views ("tenantId", "ownerUserId");
-- WORKSPACE_SECURITY
ALTER TABLE attendance_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_export_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_export_tenant ON attendance_export_jobs USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE attendance_saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_saved_views FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_view_tenant ON attendance_saved_views USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');

ALTER TABLE "Attendance" ADD COLUMN "setupVersion" INTEGER, ADD COLUMN "setupSnapshot" JSONB;
ALTER TYPE "StatusAttendance" ADD VALUE IF NOT EXISTS 'SETUP_REQUIRED';
ALTER TABLE "holidays" ADD COLUMN "startTime" TEXT, ADD COLUMN "endTime" TEXT;
ALTER TABLE "attendance_anomalies" ADD COLUMN "routingSnapshot" JSONB,
  ADD COLUMN "approvalEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE TABLE "attendance_setup_drafts" (
  "tenantId" UUID PRIMARY KEY, "version" INTEGER NOT NULL DEFAULT 1,
  "settings" JSONB NOT NULL DEFAULT '{}', "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "attendance_setup_releases" (
  "id" SERIAL PRIMARY KEY, "tenantId" UUID NOT NULL, "version" INTEGER NOT NULL,
  "effectiveFrom" DATE NOT NULL, "coverageThrough" DATE NOT NULL,
  "config" JSONB NOT NULL, "reason" TEXT NOT NULL, "publishedById" INTEGER,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attendance_setup_release_dates" CHECK ("coverageThrough" >= "effectiveFrom")
);
CREATE UNIQUE INDEX "attendance_setup_releases_tenantId_version_key" ON "attendance_setup_releases" ("tenantId", "version");
CREATE INDEX "attendance_setup_releases_tenantId_effectiveFrom_version_idx" ON "attendance_setup_releases" ("tenantId", "effectiveFrom", "version");
DO $$ DECLARE tab TEXT; BEGIN
  FOREACH tab IN ARRAY ARRAY['attendance_setup_drafts', 'attendance_setup_releases'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'')', tab);
  END LOOP;
END $$;

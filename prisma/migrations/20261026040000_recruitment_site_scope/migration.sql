ALTER TABLE "Employee" ADD COLUMN "recruitmentSiteRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "interviews" ADD COLUMN "siteRef" VARCHAR(100);
CREATE INDEX "interviews_tenant_site_schedule" ON "interviews" ("tenantId","siteRef","scheduledAt");

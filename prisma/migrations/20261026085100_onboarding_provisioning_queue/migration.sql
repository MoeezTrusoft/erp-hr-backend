CREATE UNIQUE INDEX onboarding_task_tenant_identity ON onboarding_tasks ("tenantId",id);
CREATE TABLE "OnboardingProvisioning" (
 "taskId" INTEGER PRIMARY KEY,
 "tenantId" UUID NOT NULL,
 version INTEGER NOT NULL DEFAULT 0 CHECK (version>=0),
 "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "notifiedUserId" INTEGER,
 "lastNotifiedAt" TIMESTAMP(3),
 "fulfilledAt" TIMESTAMP(3),
 "fulfilledById" INTEGER,
 reference TEXT,
 CONSTRAINT onboarding_provisioning_task FOREIGN KEY ("tenantId","taskId") REFERENCES onboarding_tasks("tenantId",id) ON UPDATE CASCADE ON DELETE CASCADE,
 CONSTRAINT onboarding_provisioning_completion CHECK (("fulfilledAt" IS NULL AND "fulfilledById" IS NULL AND reference IS NULL) OR ("fulfilledAt" IS NOT NULL AND "fulfilledById" IS NOT NULL AND "fulfilledById">0 AND reference IS NOT NULL AND length(trim(reference)) BETWEEN 1 AND 2000))
);
CREATE UNIQUE INDEX onboarding_provisioning_identity ON "OnboardingProvisioning" ("tenantId","taskId");
CREATE INDEX onboarding_provisioning_company ON "OnboardingProvisioning" ("tenantId","requestedAt","taskId");
ALTER TABLE "OnboardingProvisioning" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingProvisioning" FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_provisioning_company ON "OnboardingProvisioning" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');

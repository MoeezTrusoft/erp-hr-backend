CREATE UNIQUE INDEX onboarding_checklist_tenant_identity ON onboarding_checklists ("tenantId",id);
CREATE TABLE "OnboardingNotice" (
 id SERIAL PRIMARY KEY,
 "tenantId" UUID NOT NULL,
 "checklistId" INTEGER NOT NULL,
 "recipientUserId" INTEGER NOT NULL CHECK ("recipientUserId">0),
 "checklistStartAt" TIMESTAMP(3) NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('READINESS','DAY_30','DAY_60','DAY_90')),
 "dueAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT onboarding_notice_checklist FOREIGN KEY ("tenantId","checklistId") REFERENCES onboarding_checklists("tenantId",id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT onboarding_notice_once UNIQUE ("tenantId","checklistId","recipientUserId","checklistStartAt",kind)
);
ALTER TABLE "OnboardingNotice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingNotice" FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_notice_company ON "OnboardingNotice" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');

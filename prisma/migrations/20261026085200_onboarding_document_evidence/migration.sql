CREATE UNIQUE INDEX onboarding_document_tenant_identity ON onboarding_documents ("tenantId",id);
CREATE TABLE "OnboardingUpload" (
 id UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"checklistId" INTEGER NOT NULL,"employeeId" INTEGER NOT NULL,"createdById" INTEGER NOT NULL,
 "requestKey" TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'ORIGINAL' CHECK(kind IN ('ORIGINAL','SIGNED')),
 title TEXT NOT NULL,category TEXT,"requiresSign" BOOLEAN NOT NULL DEFAULT false,
 sha256 TEXT NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),"mimeType" TEXT NOT NULL,"byteSize" INTEGER NOT NULL CHECK("byteSize">0 AND "byteSize"<=16777216),
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','UPLOADING','SCANNING','READY','REJECTED')),
 "mediaId" INTEGER,"documentId" INTEGER,"leaseToken" UUID,"leaseUntil" TIMESTAMPTZ(3),"lastError" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT onboarding_upload_checklist FOREIGN KEY("tenantId","checklistId") REFERENCES onboarding_checklists("tenantId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT onboarding_upload_document FOREIGN KEY("tenantId","documentId") REFERENCES onboarding_documents("tenantId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT onboarding_upload_sign_type CHECK(NOT "requiresSign" OR "mimeType"='application/pdf')
);
CREATE UNIQUE INDEX onboarding_upload_request ON "OnboardingUpload"("tenantId","checklistId","requestKey");
CREATE UNIQUE INDEX onboarding_upload_document_kind ON "OnboardingUpload"("tenantId","documentId",kind);
CREATE INDEX onboarding_upload_work ON "OnboardingUpload"(state,"updatedAt");
CREATE TABLE "OnboardingDocumentEvidence" (
 "documentId" INTEGER PRIMARY KEY,"tenantId" UUID NOT NULL,sha256 TEXT NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),"mimeType" TEXT NOT NULL,"byteSize" INTEGER NOT NULL CHECK("byteSize">0),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),"reviewState" TEXT NOT NULL DEFAULT 'PENDING' CHECK("reviewState" IN ('PENDING','VERIFIED','REJECTED')),
 "reviewedAt" TIMESTAMPTZ(3),"reviewedById" INTEGER,"reviewNoteCipher" TEXT,
 CONSTRAINT onboarding_document_evidence_owner FOREIGN KEY("tenantId","documentId") REFERENCES onboarding_documents("tenantId",id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT onboarding_document_review_audit CHECK(("reviewState"='PENDING' AND "reviewedAt" IS NULL AND "reviewedById" IS NULL) OR ("reviewState"<>'PENDING' AND "reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL))
);
CREATE UNIQUE INDEX onboarding_document_evidence_identity ON "OnboardingDocumentEvidence"("tenantId","documentId");
CREATE TABLE "OnboardingDocumentSignature" (
 id UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"documentId" INTEGER NOT NULL,"employeeId" INTEGER NOT NULL,"createdById" INTEGER NOT NULL,"documentVersion" INTEGER NOT NULL,
 "originalMediaId" INTEGER NOT NULL,sha256 TEXT NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),"identityCipher" TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'PREPARE' CHECK(state IN ('PREPARE','CREATE','CREATE_UNKNOWN','AWAITING','SIGNED','DECLINED','CANCEL_PENDING','CANCELLED','FAILED')),
 "nodeId" INTEGER,"providerFileId" INTEGER,"providerFileUuid" UUID,"signingUrlCipher" TEXT,
 "signedMediaId" INTEGER,"signedSha256" TEXT,"signedAt" TIMESTAMPTZ(3),"cancelReasonCipher" TEXT,
 "dueAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"leaseToken" UUID,"leaseUntil" TIMESTAMPTZ(3),attempts INTEGER NOT NULL DEFAULT 0,"lastError" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT onboarding_signature_document FOREIGN KEY("tenantId","documentId") REFERENCES onboarding_documents("tenantId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT onboarding_verified_signature CHECK(state<>'SIGNED' OR ("signedMediaId" IS NOT NULL AND "signedSha256" IS NOT NULL AND "signedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX onboarding_signature_identity ON "OnboardingDocumentSignature"("tenantId","documentId");
CREATE INDEX onboarding_signature_work ON "OnboardingDocumentSignature"(state,"dueAt");
ALTER TABLE "OnboardingUpload" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingUpload" FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_document_company ON "OnboardingUpload" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "OnboardingDocumentEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingDocumentEvidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_document_company ON "OnboardingDocumentEvidence" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "OnboardingDocumentSignature" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingDocumentSignature" FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_document_company ON "OnboardingDocumentSignature" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');

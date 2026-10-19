-- Engagement Context Engine (communication-driven relationship context for
-- publishing leads, clients and publishing users). Additive only.
CREATE TABLE "EngagementParty" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL,
 "kind" TEXT NOT NULL DEFAULT 'PERSON', "role" TEXT NOT NULL DEFAULT 'LEAD', "stage" TEXT NOT NULL DEFAULT 'NEW',
 "displayName" TEXT NOT NULL, "organization" TEXT,
 "emails" JSONB NOT NULL DEFAULT '[]', "phones" JSONB NOT NULL DEFAULT '[]',
 "identities" JSONB NOT NULL DEFAULT '[]', "tags" JSONB NOT NULL DEFAULT '[]',
 "timezone" TEXT, "locale" TEXT, "ownerUserId" TEXT, "mergedIntoId" UUID,
 "version" INTEGER NOT NULL DEFAULT 1,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "EngagementParty_tenantId_id_key" ON "EngagementParty"("tenantId","id");
CREATE INDEX "EngagementParty_tenantId_role_stage_idx" ON "EngagementParty"("tenantId","role","stage");
CREATE INDEX "EngagementParty_tenantId_updatedAt_idx" ON "EngagementParty"("tenantId","updatedAt");
ALTER TABLE "EngagementParty" ADD CONSTRAINT engagement_party_kind CHECK ("kind" IN ('PERSON','ORGANIZATION'));
ALTER TABLE "EngagementParty" ADD CONSTRAINT engagement_party_role CHECK ("role" IN ('VISITOR','LEAD','CLIENT','PUBLISHING_USER','AUTHOR','PARTNER'));
ALTER TABLE "EngagementParty" ADD CONSTRAINT engagement_party_stage CHECK ("stage" IN ('NEW','ENGAGED','QUALIFIED','PROPOSAL','NEGOTIATION','WON','ACTIVE','DORMANT','LOST','MERGED'));

CREATE TABLE "EngagementEvent" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "partyId" UUID NOT NULL,
 "channel" TEXT NOT NULL, "direction" TEXT NOT NULL DEFAULT 'INBOUND', "sourceSystem" TEXT NOT NULL DEFAULT 'MANUAL',
 "sourceId" TEXT, "sourceThreadId" TEXT, "dedupeKey" TEXT NOT NULL,
 "occurredAt" TIMESTAMP(3) NOT NULL, "subject" TEXT, "body" TEXT NOT NULL, "bodyHash" TEXT NOT NULL,
 "participants" JSONB NOT NULL DEFAULT '[]', "attachments" JSONB NOT NULL DEFAULT '[]', "metadata" JSONB NOT NULL DEFAULT '{}',
 "extractedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "EngagementEvent_tenantId_dedupeKey_key" ON "EngagementEvent"("tenantId","dedupeKey");
CREATE INDEX "EngagementEvent_tenantId_partyId_occurredAt_idx" ON "EngagementEvent"("tenantId","partyId","occurredAt");
CREATE INDEX "EngagementEvent_tenantId_partyId_extractedAt_idx" ON "EngagementEvent"("tenantId","partyId","extractedAt");
ALTER TABLE "EngagementEvent" ADD CONSTRAINT engagement_event_channel CHECK ("channel" IN ('EMAIL','SMS','WEBCHAT','CHAT','CALL','TRANSCRIPT','VOICEMAIL','MEETING','NOTE','FORM','DOCUMENT','SYSTEM'));
ALTER TABLE "EngagementEvent" ADD CONSTRAINT engagement_event_direction CHECK ("direction" IN ('INBOUND','OUTBOUND','INTERNAL'));

CREATE TABLE "EngagementProfile" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "partyId" UUID NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 0, "summary" TEXT NOT NULL DEFAULT '', "structured" JSONB NOT NULL DEFAULT '{}',
 "model" TEXT, "lastEventAt" TIMESTAMP(3), "lastRefreshedAt" TIMESTAMP(3), "eventsAtRefresh" INTEGER NOT NULL DEFAULT 0,
 "refreshStatus" TEXT NOT NULL DEFAULT 'IDLE', "lastError" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "EngagementProfile_tenantId_partyId_key" ON "EngagementProfile"("tenantId","partyId");
CREATE INDEX "EngagementProfile_tenantId_refreshStatus_idx" ON "EngagementProfile"("tenantId","refreshStatus");
ALTER TABLE "EngagementProfile" ADD CONSTRAINT engagement_profile_status CHECK ("refreshStatus" IN ('IDLE','QUEUED','RUNNING','FAILED'));

CREATE TABLE "EngagementFact" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "partyId" UUID NOT NULL, "profileVersion" INTEGER NOT NULL,
 "kind" TEXT NOT NULL, "key" TEXT NOT NULL, "value" TEXT NOT NULL, "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
 "status" TEXT NOT NULL DEFAULT 'ACTIVE', "sourceEventId" UUID, "supersededById" UUID,
 "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "EngagementFact_tenantId_partyId_status_idx" ON "EngagementFact"("tenantId","partyId","status");
CREATE INDEX "EngagementFact_tenantId_partyId_kind_key_idx" ON "EngagementFact"("tenantId","partyId","kind","key");
ALTER TABLE "EngagementFact" ADD CONSTRAINT engagement_fact_kind CHECK ("kind" IN ('IDENTITY','CONTACT_RULE','PREFERENCE','REQUIREMENT','PROJECT_DETAIL','COMMITMENT','DECISION','OBJECTION','TIMELINE','BUDGET','RISK','SENTIMENT','OTHER'));
ALTER TABLE "EngagementFact" ADD CONSTRAINT engagement_fact_status CHECK ("status" IN ('ACTIVE','SUPERSEDED','RETRACTED'));
ALTER TABLE "EngagementFact" ADD CONSTRAINT engagement_fact_confidence CHECK ("confidence" >= 0 AND "confidence" <= 1);

CREATE TABLE "EngagementDocument" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "partyId" UUID NOT NULL,
 "kind" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'DRAFT', "title" TEXT NOT NULL, "body" TEXT NOT NULL,
 "format" TEXT NOT NULL DEFAULT 'MARKDOWN', "structured" JSONB NOT NULL DEFAULT '{}', "instructions" TEXT,
 "profileVersion" INTEGER NOT NULL DEFAULT 0, "sourceEventIds" JSONB NOT NULL DEFAULT '[]', "llmRunId" UUID,
 "version" INTEGER NOT NULL DEFAULT 1, "createdByUserId" TEXT, "approvedByUserId" TEXT, "approvedAt" TIMESTAMP(3),
 "sentAt" TIMESTAMP(3), "deliveryRef" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "EngagementDocument_tenantId_partyId_createdAt_idx" ON "EngagementDocument"("tenantId","partyId","createdAt");
CREATE INDEX "EngagementDocument_tenantId_kind_status_idx" ON "EngagementDocument"("tenantId","kind","status");
ALTER TABLE "EngagementDocument" ADD CONSTRAINT engagement_document_kind CHECK ("kind" IN ('EMAIL','SMS','CHAT_REPLY','QUOTATION','PROPOSAL','NDA','CONTRACT','EDITORIAL_ASSESSMENT','MEETING_SUMMARY','PROJECT_BRIEF','HANDOVER_BRIEF','CUSTOM'));
ALTER TABLE "EngagementDocument" ADD CONSTRAINT engagement_document_status CHECK ("status" IN ('DRAFT','REVIEWED','APPROVED','SENT','ARCHIVED'));
ALTER TABLE "EngagementDocument" ADD CONSTRAINT engagement_document_format CHECK ("format" IN ('MARKDOWN','HTML','TEXT'));

CREATE TABLE "EngagementProjectLink" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "partyId" UUID NOT NULL, "documentId" UUID,
 "requestKey" TEXT NOT NULL, "pmProjectId" INTEGER, "status" TEXT NOT NULL DEFAULT 'PROPOSED',
 "proposal" JSONB NOT NULL DEFAULT '{}', "brief" JSONB NOT NULL DEFAULT '{}',
 "lastSyncedAt" TIMESTAMP(3), "lastError" TEXT, "version" INTEGER NOT NULL DEFAULT 1,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "EngagementProjectLink_tenantId_requestKey_key" ON "EngagementProjectLink"("tenantId","requestKey");
CREATE INDEX "EngagementProjectLink_tenantId_partyId_status_idx" ON "EngagementProjectLink"("tenantId","partyId","status");
ALTER TABLE "EngagementProjectLink" ADD CONSTRAINT engagement_project_link_status CHECK ("status" IN ('PROPOSED','SYNCING','CREATED','UPDATED','FAILED','DISMISSED'));

CREATE TABLE "EngagementLlmRun" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "partyId" UUID, "purpose" TEXT NOT NULL, "model" TEXT NOT NULL,
 "inputTokens" INTEGER NOT NULL DEFAULT 0, "outputTokens" INTEGER NOT NULL DEFAULT 0,
 "cacheReadTokens" INTEGER NOT NULL DEFAULT 0, "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
 "latencyMs" INTEGER NOT NULL DEFAULT 0, "stopReason" TEXT, "status" TEXT NOT NULL DEFAULT 'SUCCEEDED',
 "errorCode" TEXT, "requestHash" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "EngagementLlmRun_tenantId_createdAt_idx" ON "EngagementLlmRun"("tenantId","createdAt");
CREATE INDEX "EngagementLlmRun_tenantId_partyId_createdAt_idx" ON "EngagementLlmRun"("tenantId","partyId","createdAt");

CREATE TABLE "EngagementInboxEvent" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "eventId" TEXT NOT NULL, "source" TEXT NOT NULL, "payload" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastErrorCode" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "processedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "EngagementInboxEvent_tenantId_eventId_key" ON "EngagementInboxEvent"("tenantId","eventId");
CREATE INDEX "EngagementInboxEvent_status_nextAttemptAt_idx" ON "EngagementInboxEvent"("status","nextAttemptAt");

CREATE TABLE "EngagementCommandReceipt" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "requestKey" TEXT NOT NULL, "toolName" TEXT NOT NULL,
 "digest" TEXT NOT NULL, "result" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "EngagementCommandReceipt_tenantId_requestKey_key" ON "EngagementCommandReceipt"("tenantId","requestKey");

-- Tenant isolation: FORCE RLS with the tenant GUC policy used by every HR table.
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['EngagementParty','EngagementEvent','EngagementProfile','EngagementFact','EngagementDocument','EngagementProjectLink','EngagementLlmRun','EngagementInboxEvent','EngagementCommandReceipt'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY engagement_tenant ON %I USING ("tenantId"=public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'')',tab);
 END LOOP;
END $$;
-- Receipts and LLM run records are audit evidence: append-only.
CREATE TRIGGER engagement_receipt_immutable BEFORE UPDATE OR DELETE ON "EngagementCommandReceipt" FOR EACH ROW EXECUTE FUNCTION hr_setup_append_only();
CREATE TRIGGER engagement_llm_run_immutable BEFORE UPDATE OR DELETE ON "EngagementLlmRun" FOR EACH ROW EXECUTE FUNCTION hr_setup_append_only();

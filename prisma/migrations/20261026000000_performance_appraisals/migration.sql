-- Additive appraisal domain. Existing legacy records are not changed.
CREATE TABLE "PerfConfiguration" (
  "tenantId" UUID NOT NULL PRIMARY KEY,
  "version" INTEGER NOT NULL DEFAULT 0,
  "coreEnabled" BOOLEAN NOT NULL DEFAULT false,
  "policy" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "PerfConfiguration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfConfiguration" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfConfiguration" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfTemplateVersion" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 0,
  "rubric" JSONB NOT NULL,
  "createdBy" INTEGER NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "name", "id"),
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfTemplateVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfTemplateVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfTemplateVersion" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfCycle" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "templateId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 0,
  "policy" JSONB NOT NULL,
  "timezone" TEXT NOT NULL,
  "periodStart" TEXT NOT NULL,
  "periodEnd" TEXT NOT NULL,
  "selfDue" TIMESTAMP(3) NOT NULL,
  "managerDue" TIMESTAMP(3) NOT NULL,
  "launchCursor" INTEGER NOT NULL DEFAULT 0,
  "launchedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "name"),
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfCycle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfCycle" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfCycle" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfParticipant" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "cycleId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL,
  "managerId" INTEGER NOT NULL,
  "reviewType" TEXT NOT NULL DEFAULT 'ANNUAL',
  "snapshot" JSONB NOT NULL,
  "inclusionState" TEXT NOT NULL DEFAULT 'INCLUDED',
  "originalSelfDue" TIMESTAMP(3) NOT NULL,
  "originalManagerDue" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "cycleId", "employeeId", "reviewType"),
  UNIQUE ("tenantId", "id")
);
CREATE INDEX "PerfParticipant_0_idx" ON "PerfParticipant" ("tenantId", "cycleId", "id");
ALTER TABLE "PerfParticipant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfParticipant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfParticipant" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfReview" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "participantId" UUID NOT NULL,
  "cycleId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL,
  "managerId" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'SELF_OPEN',
  "version" INTEGER NOT NULL DEFAULT 0,
  "revisionNo" INTEGER NOT NULL DEFAULT 0,
  "currentRevisionId" UUID,
  "selfWaiver" TEXT,
  "selfDue" TIMESTAMP(3) NOT NULL,
  "managerDue" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "appealDeadline" TEXT,
  "acknowledgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "participantId"),
  UNIQUE ("tenantId", "id")
);
CREATE INDEX "PerfReview_0_idx" ON "PerfReview" ("tenantId", "cycleId", "state");
CREATE INDEX "PerfReview_1_idx" ON "PerfReview" ("tenantId", "employeeId");
CREATE INDEX "PerfReview_2_idx" ON "PerfReview" ("tenantId", "managerId");
ALTER TABLE "PerfReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfReview" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfReview" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfResponse" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "role" TEXT NOT NULL,
  "authorId" INTEGER NOT NULL,
  "responseNo" INTEGER NOT NULL,
  "answers" JSONB NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "reviewId", "role", "authorId", "responseNo"),
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfResponse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfResponse" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfResponse" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfReviewRevision" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "revisionNo" INTEGER NOT NULL,
  "predecessorId" UUID,
  "content" JSONB NOT NULL,
  "digest" TEXT NOT NULL,
  "score" JSONB NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "reviewId", "revisionNo"),
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfReviewRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfReviewRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfReviewRevision" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfSignoff" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "revisionId" UUID,
  "actorId" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "approvedVersion" INTEGER NOT NULL,
  "reason" TEXT,
  "requestHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfSignoff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfSignoff" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfSignoff" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfEvidenceLink" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceVersion" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "verifiedBy" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfEvidenceLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfEvidenceLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfEvidenceLink" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfAppeal" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "revisionId" UUID NOT NULL,
  "filedBy" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "decideBy" TEXT NOT NULL,
  "decidedBy" INTEGER,
  "decisionReason" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "id")
);
CREATE INDEX "PerfAppeal_0_idx" ON "PerfAppeal" ("tenantId", "reviewId", "status");
ALTER TABLE "PerfAppeal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfAppeal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfAppeal" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfCommandReceipt" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "actorId" INTEGER NOT NULL,
  "operation" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "actorId", "operation", "requestKey"),
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfCommandReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfCommandReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfCommandReceipt" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfAudit" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "aggregateId" UUID NOT NULL,
  "actorId" INTEGER NOT NULL,
  "operation" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "correlationId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "id")
);
CREATE INDEX "PerfAudit_0_idx" ON "PerfAudit" ("tenantId", "aggregateId", "createdAt");
ALTER TABLE "PerfAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfAudit" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfAudit" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfGoal" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "cycleId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "parentId" UUID,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 0,
  "keyResults" JSONB NOT NULL,
  "approvedBy" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfGoal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfGoal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfGoal" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfMeasurement" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "goalId" UUID NOT NULL,
  "keyResultId" TEXT NOT NULL,
  "actual" DOUBLE PRECISION NOT NULL,
  "sourceSystem" TEXT NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "progress" JSONB NOT NULL,
  "recordedBy" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "goalId", "keyResultId", "sourceSystem", "sourceRef", "period", "sourceVersion"),
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfMeasurement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfMeasurement" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfMeasurement" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfCheckin" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL,
  "managerId" INTEGER NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "agenda" TEXT NOT NULL,
  "actions" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "employeeConfirmedAt" TIMESTAMP(3),
  "managerConfirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfCheckin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfCheckin" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfCheckin" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfFeedback" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL,
  "authorId" INTEGER NOT NULL,
  "reviewId" UUID,
  "audience" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfFeedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfFeedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfFeedback" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfDecisionCase" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "revisionId" UUID NOT NULL,
  "employeeId" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "instruction" JSONB NOT NULL,
  "proposedBy" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PROPOSED',
  "version" INTEGER NOT NULL DEFAULT 0,
  "hrApprover" INTEGER,
  "budgetApprover" INTEGER,
  "executionApprover" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfDecisionCase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfDecisionCase" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfDecisionCase" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfIntegrationHandoff" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "decisionId" UUID NOT NULL,
  "decisionVersion" INTEGER NOT NULL,
  "destination" TEXT NOT NULL,
  "businessKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'SHADOW',
  "receiverReceipt" JSONB,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "destination", "decisionId", "decisionVersion"),
  UNIQUE ("tenantId", "businessKey"),
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfIntegrationHandoff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfIntegrationHandoff" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfIntegrationHandoff" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfReminderIntent" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "recipientId" INTEGER NOT NULL,
  "scheduleVersion" INTEGER NOT NULL,
  "stage" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "hubReceipt" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "reviewId", "recipientId", "scheduleVersion", "stage"),
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfReminderIntent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfReminderIntent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfReminderIntent" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE "PerfInbox" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "consumer" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "consumer", "eventId"),
  UNIQUE ("tenantId", "id")
);
ALTER TABLE "PerfInbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfInbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PerfInbox" USING ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE "PerfCycle" ADD CONSTRAINT "PerfCycle_templateId_tenant_fk" FOREIGN KEY ("tenantId","templateId") REFERENCES "PerfTemplateVersion" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfParticipant" ADD CONSTRAINT "PerfParticipant_cycleId_tenant_fk" FOREIGN KEY ("tenantId","cycleId") REFERENCES "PerfCycle" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfReview" ADD CONSTRAINT "PerfReview_participantId_tenant_fk" FOREIGN KEY ("tenantId","participantId") REFERENCES "PerfParticipant" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfReview" ADD CONSTRAINT "PerfReview_cycleId_tenant_fk" FOREIGN KEY ("tenantId","cycleId") REFERENCES "PerfCycle" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfReview" ADD CONSTRAINT "PerfReview_currentRevisionId_tenant_fk" FOREIGN KEY ("tenantId","currentRevisionId") REFERENCES "PerfReviewRevision" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfResponse" ADD CONSTRAINT "PerfResponse_reviewId_tenant_fk" FOREIGN KEY ("tenantId","reviewId") REFERENCES "PerfReview" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfReviewRevision" ADD CONSTRAINT "PerfReviewRevision_reviewId_tenant_fk" FOREIGN KEY ("tenantId","reviewId") REFERENCES "PerfReview" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfReviewRevision" ADD CONSTRAINT "PerfReviewRevision_predecessorId_tenant_fk" FOREIGN KEY ("tenantId","predecessorId") REFERENCES "PerfReviewRevision" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfSignoff" ADD CONSTRAINT "PerfSignoff_reviewId_tenant_fk" FOREIGN KEY ("tenantId","reviewId") REFERENCES "PerfReview" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfSignoff" ADD CONSTRAINT "PerfSignoff_revisionId_tenant_fk" FOREIGN KEY ("tenantId","revisionId") REFERENCES "PerfReviewRevision" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfEvidenceLink" ADD CONSTRAINT "PerfEvidenceLink_reviewId_tenant_fk" FOREIGN KEY ("tenantId","reviewId") REFERENCES "PerfReview" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfAppeal" ADD CONSTRAINT "PerfAppeal_reviewId_tenant_fk" FOREIGN KEY ("tenantId","reviewId") REFERENCES "PerfReview" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfAppeal" ADD CONSTRAINT "PerfAppeal_revisionId_tenant_fk" FOREIGN KEY ("tenantId","revisionId") REFERENCES "PerfReviewRevision" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfGoal" ADD CONSTRAINT "PerfGoal_cycleId_tenant_fk" FOREIGN KEY ("tenantId","cycleId") REFERENCES "PerfCycle" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfGoal" ADD CONSTRAINT "PerfGoal_parentId_tenant_fk" FOREIGN KEY ("tenantId","parentId") REFERENCES "PerfGoal" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfMeasurement" ADD CONSTRAINT "PerfMeasurement_goalId_tenant_fk" FOREIGN KEY ("tenantId","goalId") REFERENCES "PerfGoal" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfFeedback" ADD CONSTRAINT "PerfFeedback_reviewId_tenant_fk" FOREIGN KEY ("tenantId","reviewId") REFERENCES "PerfReview" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfDecisionCase" ADD CONSTRAINT "PerfDecisionCase_reviewId_tenant_fk" FOREIGN KEY ("tenantId","reviewId") REFERENCES "PerfReview" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfDecisionCase" ADD CONSTRAINT "PerfDecisionCase_revisionId_tenant_fk" FOREIGN KEY ("tenantId","revisionId") REFERENCES "PerfReviewRevision" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfIntegrationHandoff" ADD CONSTRAINT "PerfIntegrationHandoff_decisionId_tenant_fk" FOREIGN KEY ("tenantId","decisionId") REFERENCES "PerfDecisionCase" ("tenantId","id") ON DELETE RESTRICT;
ALTER TABLE "PerfReminderIntent" ADD CONSTRAINT "PerfReminderIntent_reviewId_tenant_fk" FOREIGN KEY ("tenantId","reviewId") REFERENCES "PerfReview" ("tenantId","id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "PerfAppeal_one_open" ON "PerfAppeal" ("tenantId","reviewId") WHERE status='OPEN';

CREATE FUNCTION perf_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Appraisal attested records are immutable' USING ERRCODE='23514'; END $$;
CREATE FUNCTION perf_response_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD."submittedAt" IS NOT NULL THEN RAISE EXCEPTION 'Submitted response is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER perf_response_frozen BEFORE UPDATE OR DELETE ON "PerfResponse" FOR EACH ROW EXECUTE FUNCTION perf_response_frozen();
CREATE FUNCTION perf_template_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='PUBLISHED' THEN RAISE EXCEPTION 'Published template is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER perf_template_frozen BEFORE UPDATE OR DELETE ON "PerfTemplateVersion" FOR EACH ROW EXECUTE FUNCTION perf_template_frozen();
CREATE FUNCTION perf_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."tenantId"<>OLD."tenantId" OR NEW."participantId"<>OLD."participantId" OR NEW."employeeId"<>OLD."employeeId" OR NEW."cycleId"<>OLD."cycleId" THEN RAISE EXCEPTION 'Review attribution cannot be changed' USING ERRCODE='23514'; END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Review update must increment version' USING ERRCODE='23514'; END IF;
 IF NEW.state='RELEASED' AND OLD.state<>'RELEASED' AND NOT EXISTS (
   SELECT 1 FROM "PerfSignoff" s WHERE s."tenantId"=NEW."tenantId" AND s."reviewId"=NEW.id AND s."revisionId"=NEW."currentRevisionId" AND s.action='RELEASE' AND s."approvedVersion"=OLD.version AND s."actorId" NOT IN (NEW."employeeId",NEW."managerId")
 ) THEN RAISE EXCEPTION 'Independent release signoff required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER perf_review_guard BEFORE UPDATE ON "PerfReview" FOR EACH ROW EXECUTE FUNCTION perf_review_guard();

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "PerfParticipant" FOR EACH ROW EXECUTE FUNCTION perf_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "PerfReviewRevision" FOR EACH ROW EXECUTE FUNCTION perf_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "PerfSignoff" FOR EACH ROW EXECUTE FUNCTION perf_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "PerfEvidenceLink" FOR EACH ROW EXECUTE FUNCTION perf_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "PerfCommandReceipt" FOR EACH ROW EXECUTE FUNCTION perf_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "PerfAudit" FOR EACH ROW EXECUTE FUNCTION perf_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "PerfMeasurement" FOR EACH ROW EXECUTE FUNCTION perf_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "PerfFeedback" FOR EACH ROW EXECUTE FUNCTION perf_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "PerfInbox" FOR EACH ROW EXECUTE FUNCTION perf_immutable();

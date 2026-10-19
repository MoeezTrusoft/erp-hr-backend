-- Phase 2.5 / 10 — candidate privacy, DNC, retention.
--
-- Candidate rows predating this migration keep consentStatus = 'UNKNOWN' (never
-- silently treated as consent) and retentionUntil = NULL (no retention clock until
-- a policy exists for the tenant), so no legacy data is deleted or reclassified by
-- applying this migration.

ALTER TABLE "Candidate"
  ADD COLUMN "consentStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "consentUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "retentionUntil" TIMESTAMP(3),
  ADD COLUMN "anonymizedAt" TIMESTAMP(3),
  ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Candidate_tenantId_status_idx" ON "Candidate"("tenantId", "status");
CREATE INDEX "Candidate_tenantId_retentionUntil_idx" ON "Candidate"("tenantId", "retentionUntil");

CREATE TABLE "candidate_consents" (
  "id" SERIAL NOT NULL,
  "candidateId" INTEGER NOT NULL,
  "tenantId" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "policyVersion" TEXT,
  "source" TEXT,
  "evidence" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedById" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_consents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "candidate_consents_tenantId_idx" ON "candidate_consents"("tenantId");
CREATE INDEX "candidate_consents_candidateId_purpose_occurredAt_idx"
  ON "candidate_consents"("candidateId", "purpose", "occurredAt");

ALTER TABLE "candidate_consents" ADD CONSTRAINT "candidate_consents_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "candidate_dnc_entries" (
  "id" SERIAL NOT NULL,
  "tenantId" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "candidateId" INTEGER,
  "reasonCode" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'ALL',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "createdById" INTEGER,
  "liftedAt" TIMESTAMP(3),
  "liftedById" INTEGER,
  "liftReason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "candidate_dnc_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "candidate_dnc_entries_tenantId_idx" ON "candidate_dnc_entries"("tenantId");
CREATE INDEX "candidate_dnc_entries_tenantId_email_status_idx"
  ON "candidate_dnc_entries"("tenantId", "email", "status");

CREATE TABLE "candidate_retention_policies" (
  "id" SERIAL NOT NULL,
  "tenantId" UUID NOT NULL,
  "appliesTo" TEXT NOT NULL,
  "retentionMonths" INTEGER NOT NULL,
  "legalBasis" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "candidate_retention_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "candidate_retention_policies_tenantId_appliesTo_key"
  ON "candidate_retention_policies"("tenantId", "appliesTo");
CREATE INDEX "candidate_retention_policies_tenantId_idx" ON "candidate_retention_policies"("tenantId");

CREATE TABLE "candidate_legal_holds" (
  "id" SERIAL NOT NULL,
  "tenantId" UUID NOT NULL,
  "candidateId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "placedById" INTEGER,
  "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMP(3),
  "releasedById" INTEGER,
  "releaseReason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_legal_holds_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "candidate_legal_holds_tenantId_idx" ON "candidate_legal_holds"("tenantId");
CREATE INDEX "candidate_legal_holds_candidateId_releasedAt_idx"
  ON "candidate_legal_holds"("candidateId", "releasedAt");

ALTER TABLE "candidate_legal_holds" ADD CONSTRAINT "candidate_legal_holds_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "candidate_anonymization_logs" (
  "id" SERIAL NOT NULL,
  "tenantId" UUID NOT NULL,
  "candidateId" INTEGER NOT NULL,
  "redactedFields" TEXT[],
  "reason" TEXT NOT NULL,
  "legalBasis" TEXT,
  "retainedSummary" JSONB,
  "performedById" INTEGER,
  "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_anonymization_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "candidate_anonymization_logs_tenantId_idx" ON "candidate_anonymization_logs"("tenantId");
CREATE INDEX "candidate_anonymization_logs_candidateId_idx" ON "candidate_anonymization_logs"("candidateId");

CREATE TABLE "candidate_data_access_requests" (
  "id" SERIAL NOT NULL,
  "tenantId" UUID NOT NULL,
  "candidateId" INTEGER,
  "subjectEmail" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "handledById" INTEGER,
  "notes" TEXT,
  "rejectionReason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "candidate_data_access_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "candidate_data_access_requests_tenantId_idx"
  ON "candidate_data_access_requests"("tenantId");
CREATE INDEX "candidate_data_access_requests_tenantId_status_dueAt_idx"
  ON "candidate_data_access_requests"("tenantId", "status", "dueAt");

-- ── App-role grants + FORCE ROW LEVEL SECURITY on the 6 new tables ───────────
-- Fleet convention for a tenant table: hr_app gets the DML grant, the policy is
-- what actually filters by tenant, and the matching RLS_MODELS entry in
-- src/lib/rlsTenant.js is what sets the GUC the policy reads. A grant without a
-- policy is unscoped (the table reads across tenants); a policy without the
-- model entry reads back EMPTY, because nothing ever sets the GUC.
--
-- Unlike the legacy fleet tables, every table here has a NOT NULL tenantId, so
-- the policy needs no null-tenant arm: there is no "global" row to preserve.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['candidate_consents','candidate_dnc_entries','candidate_retention_policies','candidate_legal_holds','candidate_anonymization_logs','candidate_data_access_requests']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hr_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'') '
      'WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'')',
      t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

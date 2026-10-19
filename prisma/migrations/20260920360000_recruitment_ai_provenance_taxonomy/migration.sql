-- Phase 13 / decision record §7.2 + §7.4 — the skills-alias taxonomy layer and
-- the AI inference provenance ledger.
--
-- §7.2/§7.2a: the canonical Skill catalogue stays deterministic reference data;
-- skill_aliases is its synonym/alias resolution layer plus tenant extensions.
-- AI may SUGGEST aliases (origin = 'ai-suggested') but a resolution only exists
-- if a row (or a Skill) says so — fuzzy free-text matching is never the source
-- of truth.
--
-- §7.4: ai_inference_records stores enough to reproduce/audit the technology
-- path WITHOUT duplicating sensitive content — provider, model, promptKey (the
-- plane's registry key = prompt/template version), input-content hash,
-- output-schema version, status/failure, confidence, trace id. Candidate-linked
-- rows follow the candidate retention/erasure policy (§7.4a): the candidate FK
-- is ON DELETE CASCADE so erasure removes the person-linked rows.
--
-- Conventions per F-DB-05: nullable tenantId (fail-closed RLS), staged NOT
-- VALID check, own RLS policy, explicit indexes.

CREATE TABLE "skill_aliases" (
    "id" SERIAL PRIMARY KEY,
    "skillId" INTEGER NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "alias" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'TENANT',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" UUID
);

CREATE TABLE "ai_inference_records" (
    "id" SERIAL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "promptKey" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "inputHash" TEXT NOT NULL,
    "outputSchemaV" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "confidence" DOUBLE PRECISION,
    "tokensUsed" INTEGER,
    "traceId" TEXT,
    -- NB: the Candidate model is legacy-unmapped (PascalCase physical table),
    -- unlike the @@map'd recruitment tables.
    "candidateId" INTEGER REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "applicationId" INTEGER,
    "requisitionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" UUID
);

-- Staged integrity checks (NOT VALID: cheap to add, enforced for new writes,
-- validated in a follow-up once legacy data is cleaned).
ALTER TABLE "skill_aliases" ADD CONSTRAINT "skill_aliases_scope_check"
    CHECK ("scope" IN ('PLATFORM', 'TENANT')) NOT VALID;
ALTER TABLE "skill_aliases" ADD CONSTRAINT "skill_aliases_origin_check"
    CHECK ("origin" IN ('manual', 'ai-suggested')) NOT VALID;
ALTER TABLE "skill_aliases" ADD CONSTRAINT "skill_aliases_status_check"
    CHECK ("status" IN ('ACTIVE', 'RETIRED')) NOT VALID;

ALTER TABLE "ai_inference_records" ADD CONSTRAINT "ai_inference_records_kind_check"
    CHECK ("kind" IN ('resume-parse', 'candidate-match')) NOT VALID;
ALTER TABLE "ai_inference_records" ADD CONSTRAINT "ai_inference_records_status_check"
    CHECK ("status" IN ('ok', 'error', 'pending', 'degraded-unavailable')) NOT VALID;

CREATE INDEX "skill_aliases_tenantId_idx" ON "skill_aliases"("tenantId");
CREATE INDEX "skill_aliases_skillId_idx" ON "skill_aliases"("skillId");
CREATE UNIQUE INDEX "skill_aliases_tenantId_alias_key" ON "skill_aliases"("tenantId", "alias");

CREATE INDEX "ai_inference_records_tenantId_kind_idx" ON "ai_inference_records"("tenantId", "kind");
CREATE INDEX "ai_inference_records_candidateId_idx" ON "ai_inference_records"("candidateId");
CREATE INDEX "ai_inference_records_requisitionId_idx" ON "ai_inference_records"("requisitionId");
CREATE INDEX "ai_inference_records_createdAt_idx" ON "ai_inference_records"("createdAt");

-- RLS: fail-closed on tenant. Platform-scope aliases (tenantId NULL) are
-- system-managed rows; services reach them through the service role, matching
-- every other nullable-tenant recruitment table.
ALTER TABLE "skill_aliases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_inference_records" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "skill_aliases_tenant_isolation" ON "skill_aliases"
    USING ("tenantId"::text = current_setting('app.tenant_id', true));
CREATE POLICY "ai_inference_records_tenant_isolation" ON "ai_inference_records"
    USING ("tenantId"::text = current_setting('app.tenant_id', true));

-- Phase 2.2 — requisition expansion.
--
-- Ten fields the plan calls for, plus a typed attachment table. Every column is
-- NULLABLE on purpose (decision record §1.1): live requisitions must stay
-- readable and editable, and an existing draft COMPLIES AT SUBMISSION rather
-- than being force-migrated. Nothing is backfilled and nothing is deleted.
--
-- salary band = gradeLevelId → GradeLevel, whose minSalary/midSalary/maxSalary/
-- bandCurrency already exist. Copying those numbers onto the requisition would
-- create a second salary truth that drifts the moment a band is re-tuned.
--
-- costCenterRef/budgetRef are FINANCE-OWNED references. The *Label columns are a
-- display cache only — they exist so a requisition can render without a
-- synchronous cross-service call, and are never the source of truth (§1.2).
--
-- budgetApprovalSnapshot captures what Finance/headcount said AT APPROVAL so a
-- later change cannot silently rewrite history; it is not a second source of
-- truth either (§2.2).

ALTER TABLE "JobRequisition"
    ADD COLUMN IF NOT EXISTS "location"               TEXT,
    ADD COLUMN IF NOT EXISTS "employmentType"         TEXT,
    ADD COLUMN IF NOT EXISTS "targetStartDate"        TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "gradeLevelId"           INTEGER,
    ADD COLUMN IF NOT EXISTS "costCenterRef"          TEXT,
    ADD COLUMN IF NOT EXISTS "costCenterLabel"        TEXT,
    ADD COLUMN IF NOT EXISTS "budgetRef"              TEXT,
    ADD COLUMN IF NOT EXISTS "budgetLabel"            TEXT,
    ADD COLUMN IF NOT EXISTS "hiringReason"           TEXT,
    ADD COLUMN IF NOT EXISTS "replacementEmployeeId"  INTEGER,
    ADD COLUMN IF NOT EXISTS "recruiterId"            INTEGER,
    ADD COLUMN IF NOT EXISTS "jobContent"             JSONB,
    ADD COLUMN IF NOT EXISTS "publishedAt"            TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "closedAt"               TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "budgetApprovalSnapshot" JSONB;

CREATE INDEX IF NOT EXISTS "JobRequisition_recruiterId_idx"
    ON "JobRequisition"("recruiterId");
CREATE INDEX IF NOT EXISTS "JobRequisition_gradeLevelId_idx"
    ON "JobRequisition"("gradeLevelId");

-- employmentType is constrained to the vocabulary the service validates against.
-- A CHECK (not an enum) so adding a value later is a one-line migration rather
-- than an enum rewrite; NULL stays legal for un-migrated drafts.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'JobRequisition_employmentType_check'
    ) THEN
        ALTER TABLE "JobRequisition"
            ADD CONSTRAINT "JobRequisition_employmentType_check"
            CHECK ("employmentType" IS NULL OR "employmentType" IN
                ('FULL_TIME','PART_TIME','CONTRACT','INTERN','TEMPORARY'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'JobRequisition_hiringReason_check'
    ) THEN
        ALTER TABLE "JobRequisition"
            ADD CONSTRAINT "JobRequisition_hiringReason_check"
            CHECK ("hiringReason" IS NULL OR "hiringReason" IN
                ('NEW_HIRE','REPLACEMENT','EXPANSION','SEASONAL','PROJECT','OTHER'));
    END IF;
END $$;

-- A REPLACEMENT requisition with nobody named is the case the plan explicitly
-- calls out. The constraint is deliberately one-directional: naming a
-- replacement employee on a NEW_HIRE is tolerated (a draft may be reclassified),
-- but a REPLACEMENT without one can never be stored, so the submission gate and
-- the database agree rather than relying on the gate alone.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'JobRequisition_replacement_requires_employee_check'
    ) THEN
        ALTER TABLE "JobRequisition"
            ADD CONSTRAINT "JobRequisition_replacement_requires_employee_check"
            CHECK ("hiringReason" IS DISTINCT FROM 'REPLACEMENT'
                   OR "replacementEmployeeId" IS NOT NULL);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'JobRequisition_gradeLevelId_fkey'
    ) THEN
        ALTER TABLE "JobRequisition"
            ADD CONSTRAINT "JobRequisition_gradeLevelId_fkey"
            FOREIGN KEY ("gradeLevelId") REFERENCES "GradeLevel"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'JobRequisition_recruiterId_fkey'
    ) THEN
        ALTER TABLE "JobRequisition"
            ADD CONSTRAINT "JobRequisition_recruiterId_fkey"
            FOREIGN KEY ("recruiterId") REFERENCES "Employee"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'JobRequisition_replacementEmployeeId_fkey'
    ) THEN
        ALTER TABLE "JobRequisition"
            ADD CONSTRAINT "JobRequisition_replacementEmployeeId_fkey"
            FOREIGN KEY ("replacementEmployeeId") REFERENCES "Employee"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- ── Typed, ACL'd requisition attachments (§1.4) ──────────────────────────────
--
-- The bytes live in DAM; this is the pointer. `visibility` separates a document
-- the HIRING_TEAM may read from one only INTERNAL (recruiter/HR/approver) may.
-- There is deliberately no candidate-facing value: candidate-facing publication
-- assets are managed separately, so an internal budget justification attached
-- here cannot leak into an interviewer's or candidate's view by default.

CREATE TABLE IF NOT EXISTS "requisition_attachments" (
    "id"            SERIAL NOT NULL,
    "requisitionId" INTEGER NOT NULL,
    "tenantId"      UUID,
    "category"      TEXT NOT NULL,
    "visibility"    TEXT NOT NULL DEFAULT 'INTERNAL',
    "mediaId"       INTEGER,
    "fileName"      TEXT,
    "label"         TEXT,
    "uploadedById"  INTEGER,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requisition_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "requisition_attachments_tenantId_idx"
    ON "requisition_attachments"("tenantId");
CREATE INDEX IF NOT EXISTS "requisition_attachments_requisitionId_idx"
    ON "requisition_attachments"("requisitionId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'requisition_attachments_category_check'
    ) THEN
        ALTER TABLE "requisition_attachments"
            ADD CONSTRAINT "requisition_attachments_category_check"
            CHECK ("category" IN
                ('JOB_DESCRIPTION','BUSINESS_JUSTIFICATION','BUDGET_APPROVAL',
                 'HIRING_APPROVAL','OTHER_INTERNAL'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'requisition_attachments_visibility_check'
    ) THEN
        ALTER TABLE "requisition_attachments"
            ADD CONSTRAINT "requisition_attachments_visibility_check"
            CHECK ("visibility" IN ('INTERNAL','HIRING_TEAM'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'requisition_attachments_requisitionId_fkey'
    ) THEN
        ALTER TABLE "requisition_attachments"
            ADD CONSTRAINT "requisition_attachments_requisitionId_fkey"
            FOREIGN KEY ("requisitionId") REFERENCES "JobRequisition"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "requisition_attachments" TO hr_app;
ALTER TABLE "requisition_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "requisition_attachments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "requisition_attachments";
CREATE POLICY tenant_isolation ON "requisition_attachments"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

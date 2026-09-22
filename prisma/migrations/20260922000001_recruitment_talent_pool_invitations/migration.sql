-- FR-10 residue — the talent-pool invitation LIFECYCLE and the retention-clock
-- POPULATION marker.
--
-- Two additive changes, no column altered and no row touched:
--
--   1. talent_pool_invitations — "invited to apply" was free text appended to a
--      pool row. A note cannot answer whether an invitation is open, answered or
--      lapsed, so the process could not be reported on. One row per invitation,
--      with a closed status vocabulary and one-way transitions
--      (lib/talentPoolPolicy.js owns the map).
--
--   2. candidates.retentionPopulation — the TALENT_POOL retention clock is
--      stamped onto the candidate (Phase 10), but the APPLICANT sweep reads that
--      same column. Without a marker, a candidate kept on file for future roles
--      was erasable by the APPLICANT sweep under the wrong lawful basis. NULL is
--      the pre-existing clocks, which were all stamped under the APPLICANT
--      policy because that is the only one that existed then.

CREATE TABLE IF NOT EXISTS "talent_pool_invitations" (
    "id"                SERIAL NOT NULL,
    "tenantId"          UUID,
    "candidateId"       INTEGER NOT NULL,
    "jobRequisitionId"  INTEGER,
    "poolName"          TEXT,
    "status"            TEXT NOT NULL,
    "invitedById"       INTEGER,
    "invitedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"         TIMESTAMP(3),
    "respondedAt"       TIMESTAMP(3),
    "responseNote"      TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- No DEFAULT: @updatedAt is maintained by the CLIENT, so a DEFAULT here is
    -- drift the F-DB-01 chain check catches.
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "talent_pool_invitations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "talent_pool_invitations"
    ADD CONSTRAINT "talent_pool_invitations_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "talent_pool_invitations"
    ADD CONSTRAINT "talent_pool_invitations_jobRequisitionId_fkey"
    FOREIGN KEY ("jobRequisitionId") REFERENCES "JobRequisition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "talent_pool_invitations_tenantId_idx"
    ON "talent_pool_invitations"("tenantId");
CREATE INDEX IF NOT EXISTS "talent_pool_invitations_tenantId_status_expiresAt_idx"
    ON "talent_pool_invitations"("tenantId", "status", "expiresAt");
CREATE INDEX IF NOT EXISTS "talent_pool_invitations_candidateId_idx"
    ON "talent_pool_invitations"("candidateId");

-- The closed status vocabulary: a status outside it would have no transition
-- rule, so the invitation could never move again.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'talent_pool_invitations_status_check'
    ) THEN
        ALTER TABLE "talent_pool_invitations"
            ADD CONSTRAINT "talent_pool_invitations_status_check"
            CHECK ("status" IN ('INVITED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'));
    END IF;
END $$;

-- An answered invitation must carry the moment it was answered: the response is
-- the point of the row, and a status without its timestamp cannot be reported.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'talent_pool_invitations_responded_check'
    ) THEN
        ALTER TABLE "talent_pool_invitations"
            ADD CONSTRAINT "talent_pool_invitations_responded_check"
            CHECK (
                ("status" = 'INVITED' AND "respondedAt" IS NULL)
                OR ("status" <> 'INVITED' AND "respondedAt" IS NOT NULL)
            );
    END IF;
END $$;

-- At most ONE open invitation per candidate per role. A partial unique index
-- rather than a plain one because answered invitations are history: inviting the
-- same candidate to the same role twice is a data bug, but re-inviting after a
-- decline (or a lapse) must stay possible. The pool-wide (role-less) case is
-- service-checked, since Postgres treats NULLs as distinct and cannot express it.
CREATE UNIQUE INDEX IF NOT EXISTS "talent_pool_invitations_open_role_key"
    ON "talent_pool_invitations" ("tenantId", "candidateId", "jobRequisitionId")
    WHERE "status" = 'INVITED' AND "jobRequisitionId" IS NOT NULL;

ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "retentionPopulation" TEXT;

ALTER TABLE "candidates"
    DROP CONSTRAINT IF EXISTS "candidates_retentionPopulation_check";
ALTER TABLE "candidates"
    ADD CONSTRAINT "candidates_retentionPopulation_check"
    CHECK ("retentionPopulation" IS NULL OR "retentionPopulation" IN ('APPLICANT', 'TALENT_POOL'));

-- ── F-DB-05 convention: staged NOT VALID backfill + own RLS policies ───────────

ALTER TABLE "talent_pool_invitations" ADD CONSTRAINT "talent_pool_invitations_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "talent_pool_invitations" TO hr_app;
ALTER TABLE "talent_pool_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "talent_pool_invitations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "talent_pool_invitations";
CREATE POLICY tenant_isolation ON "talent_pool_invitations"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

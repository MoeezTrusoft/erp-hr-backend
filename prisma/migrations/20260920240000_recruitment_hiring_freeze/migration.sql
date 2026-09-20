-- Phase 4 / decision record §2.7 — hiring freeze.
--
-- Company-wide or department-level. A freeze blocks SUBMISSION and PUBLICATION;
-- drafting continues. Managed through a dedicated `hr.recruitment.freeze`
-- permission (see routeAuthorization RESOURCE_PREFIXES) rather than the general
-- recruitment grant, so an ordinary recruiter cannot lift a freeze.
--
-- Additive: no existing table or column is touched, nothing is deleted. Lift is a
-- state change (isActive false + who/when/why), never a DELETE, so the record of
-- a freeze survives the freeze.

CREATE TABLE IF NOT EXISTS "recruitment_hiring_freezes" (
    "id"           SERIAL NOT NULL,
    "tenantId"     UUID,
    "scope"        TEXT NOT NULL DEFAULT 'COMPANY',
    "departmentId" INTEGER,
    "reason"       TEXT NOT NULL,
    "isActive"     BOOLEAN NOT NULL DEFAULT true,
    "createdById"  INTEGER,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedById"   INTEGER,
    "liftedAt"     TIMESTAMP(3),
    "liftReason"   TEXT,

    CONSTRAINT "recruitment_hiring_freezes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "recruitment_hiring_freezes_tenantId_idx"
    ON "recruitment_hiring_freezes"("tenantId");
CREATE INDEX IF NOT EXISTS "recruitment_hiring_freezes_tenantId_isActive_idx"
    ON "recruitment_hiring_freezes"("tenantId", "isActive");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'recruitment_hiring_freezes_scope_check'
    ) THEN
        ALTER TABLE "recruitment_hiring_freezes"
            ADD CONSTRAINT "recruitment_hiring_freezes_scope_check"
            CHECK ("scope" IN ('COMPANY','BUSINESS_UNIT'));
    END IF;
END $$;

-- A department-level freeze that names no department would silently be a
-- company-wide freeze — the worst possible failure mode for a control people
-- trust. Refused at the database, not just in the service.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'recruitment_hiring_freezes_scope_department_check'
    ) THEN
        ALTER TABLE "recruitment_hiring_freezes"
            ADD CONSTRAINT "recruitment_hiring_freezes_scope_department_check"
            CHECK (
                ("scope" = 'COMPANY' AND "departmentId" IS NULL)
                OR ("scope" = 'BUSINESS_UNIT' AND "departmentId" IS NOT NULL)
            );
    END IF;
END $$;

-- A freeze is an accountability record, so it cannot be reasonless …
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'recruitment_hiring_freezes_reason_check'
    ) THEN
        ALTER TABLE "recruitment_hiring_freezes"
            ADD CONSTRAINT "recruitment_hiring_freezes_reason_check"
            CHECK (btrim("reason") <> '');
    END IF;
END $$;

-- … and neither can lifting it, once it has been lifted.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'recruitment_hiring_freezes_lift_reason_check'
    ) THEN
        ALTER TABLE "recruitment_hiring_freezes"
            ADD CONSTRAINT "recruitment_hiring_freezes_lift_reason_check"
            CHECK ("liftedAt" IS NULL OR btrim(coalesce("liftReason", '')) <> '');
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "recruitment_hiring_freezes" TO hr_app;
ALTER TABLE "recruitment_hiring_freezes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recruitment_hiring_freezes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "recruitment_hiring_freezes";
CREATE POLICY tenant_isolation ON "recruitment_hiring_freezes"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

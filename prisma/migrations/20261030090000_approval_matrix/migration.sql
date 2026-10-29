-- Configurable approval matrices. ATTENDANCE and PAYROLL each get their own versioned route
-- (ordered levels: recommend / verify / approve). A submitted request seals the published route,
-- so requests already in flight (route IS NULL) keep the four fixed stages.

-- CreateTable
CREATE TABLE "approval_matrices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "levels" JSONB NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_matrices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT approval_matrix_kind CHECK (kind IN ('ATTENDANCE','PAYROLL')),
    CONSTRAINT approval_matrix_status CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED')),
    CONSTRAINT approval_matrix_levels_array CHECK (jsonb_typeof(levels)='array' AND jsonb_array_length(levels) BETWEEN 1 AND 8)
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_matrices_tenantId_kind_version_key" ON "approval_matrices"("tenantId", "kind", "version");
-- One draft and one published matrix per company and kind.
CREATE UNIQUE INDEX "approval_matrices_one_draft" ON "approval_matrices"("tenantId", "kind") WHERE status = 'DRAFT';
CREATE UNIQUE INDEX "approval_matrices_one_published" ON "approval_matrices"("tenantId", "kind") WHERE status = 'PUBLISHED';

-- AlterTable: the sealed route of a request, the level it waits at and who may act there.
ALTER TABLE "HrApprovalRequest" ADD COLUMN "route" JSONB;
ALTER TABLE "HrApprovalRequest" ADD COLUMN "level" INTEGER;
ALTER TABLE "HrApprovalRequest" ADD COLUMN "pendingCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "HrApprovalRequest_pendingCodes_idx" ON "HrApprovalRequest" USING GIN ("pendingCodes");

-- APPROVAL_MATRIX_SECURITY
ALTER TABLE "approval_matrices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_matrices" FORCE ROW LEVEL SECURITY;
CREATE POLICY hr_approval_matrix_company ON "approval_matrices"
  USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on')
  WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');

-- A published route is history: only its status may move to SUPERSEDED.
CREATE FUNCTION approval_matrix_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status<>'DRAFT' THEN RAISE EXCEPTION 'HR-4205: A published approval matrix cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status<>'DRAFT' THEN
    IF NEW.levels IS DISTINCT FROM OLD.levels OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
       OR NOT (NEW.status=OLD.status OR (OLD.status='PUBLISHED' AND NEW.status='SUPERSEDED'))
    THEN RAISE EXCEPTION 'HR-4205: A published approval matrix is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_matrix_immutable BEFORE UPDATE OR DELETE ON "approval_matrices"
  FOR EACH ROW EXECUTE FUNCTION approval_matrix_immutable();

ALTER TABLE "HrApprovalRequest" DROP CONSTRAINT IF EXISTS hr_approval_stage;
ALTER TABLE "HrApprovalRequest" ADD CONSTRAINT hr_approval_stage
  CHECK (stage IN ('INITIATOR','LINE_MANAGER','HR','MANAGEMENT','LEVEL','APPROVED','REJECTED','WITHDRAWN'));
ALTER TABLE "HrApprovalRequest" ADD CONSTRAINT hr_approval_route_level
  CHECK (stage<>'LEVEL' OR (route IS NOT NULL AND level IS NOT NULL));

CREATE TABLE "PerfApprovalBinding" (
  id UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "approvalRef" UUID NOT NULL,
  "reviewId" UUID NOT NULL, "revisionId" UUID NOT NULL,
  "reviewVersion" INTEGER NOT NULL CHECK ("reviewVersion">=0),
  purpose TEXT NOT NULL CHECK (purpose IN ('SENIOR','RELEASE')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId","approvalRef"),
  UNIQUE ("tenantId","reviewId","revisionId","reviewVersion",purpose),
  FOREIGN KEY ("tenantId","approvalRef") REFERENCES "HrApprovalRequest"("tenantId",id),
  FOREIGN KEY ("tenantId","reviewId","revisionId") REFERENCES "PerfReviewRevision"("tenantId","reviewId",id)
);
ALTER TABLE "PerfApprovalBinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerfApprovalBinding" FORCE ROW LEVEL SECURITY;
CREATE POLICY perf_tenant ON "PerfApprovalBinding"
  USING ("tenantId"=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK ("tenantId"=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER perf_approval_binding_immutable BEFORE UPDATE OR DELETE ON "PerfApprovalBinding"
  FOR EACH ROW EXECUTE FUNCTION perf_immutable();

CREATE FUNCTION perf_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE required_purpose TEXT;
BEGIN
  required_purpose=CASE WHEN OLD.state='APPROVAL_PENDING' AND NEW.state='CALIBRATION_READY' THEN 'SENIOR'
    WHEN OLD.state='CALIBRATED' AND NEW.state='RELEASED' THEN 'RELEASE' END;
  IF required_purpose IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "PerfApprovalBinding" b JOIN "HrApprovalRequest" a
      ON a."tenantId"=b."tenantId" AND a.id=b."approvalRef"
    JOIN "HrApprovalAudit" h ON h."tenantId"=a."tenantId" AND h."approvalRef"=a.id AND h.version=a.version
    WHERE b."tenantId"=NEW."tenantId" AND b."reviewId"=NEW.id
      AND b."revisionId"=OLD."currentRevisionId" AND b."reviewVersion"=OLD.version
      AND b.purpose=required_purpose AND a.kind='PERFORMANCE' AND a.stage='APPROVED'
      AND a.execution='APPLIED' AND h.action='APPROVE' AND h."toStage"='APPROVED'
  ) THEN RAISE EXCEPTION 'Exact-version Approval Centre approval required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER perf_approval_guard BEFORE UPDATE ON "PerfReview"
  FOR EACH ROW EXECUTE FUNCTION perf_approval_guard();

CREATE FUNCTION perf_approval_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW."sourceRef" IS DISTINCT FROM OLD."sourceRef"
    OR NEW."sourceHash" IS DISTINCT FROM OLD."sourceHash" OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW."employeeCode" IS DISTINCT FROM OLD."employeeCode" OR NEW."managerCode" IS DISTINCT FROM OLD."managerCode"
    OR NEW."managerActorCode" IS DISTINCT FROM OLD."managerActorCode"
    OR OLD.stage<>'MANAGEMENT' OR NEW.stage NOT IN ('APPROVED','WITHDRAWN') OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'Appraisal approval source and completed request are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER perf_approval_request_guard BEFORE UPDATE OR DELETE ON "HrApprovalRequest"
  FOR EACH ROW WHEN (OLD.kind='PERFORMANCE' AND OLD."sourceRef" LIKE 'perf:%')
  EXECUTE FUNCTION perf_approval_request_guard();

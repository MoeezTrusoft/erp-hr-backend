CREATE UNIQUE INDEX payroll_runs_tenant_id_id ON payroll_runs("tenantId",id);
CREATE TABLE "payroll_finance_summaries" (
  "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL,
  "month" TEXT NOT NULL, "runId" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL CHECK (revision > 0), "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','CANCELLED')),
  "requestId" TEXT NOT NULL, "inputHash" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "reason" TEXT NOT NULL, "preparedBy" TEXT NOT NULL, "approvedBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "approvedAt" TIMESTAMPTZ,
  UNIQUE ("tenantId","month","revision"), UNIQUE ("tenantId","requestId"),
  FOREIGN KEY ("tenantId","runId") REFERENCES payroll_runs("tenantId",id),
  CHECK ("approvedBy" IS NULL OR "approvedBy" <> "preparedBy"),
  CHECK (status <> 'APPROVED' OR ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL))
);
-- PAYROLL_FINANCE_SECURITY
ALTER TABLE payroll_finance_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_finance_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_finance_tenant ON payroll_finance_summaries
USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on')
WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
CREATE FUNCTION payroll_finance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('APPROVED','CANCELLED') THEN RAISE EXCEPTION 'Closed payroll summary is immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_finance_immutable BEFORE UPDATE OR DELETE ON payroll_finance_summaries
FOR EACH ROW EXECUTE FUNCTION payroll_finance_immutable();

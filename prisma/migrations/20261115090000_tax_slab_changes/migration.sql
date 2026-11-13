-- Income-tax slabs are changed by a request that the company's published PAYROLL route approves (HR_APPROVAL kind
-- TAX_SLAB_CHANGE). One request replaces a country's whole slab set from a chosen date; only the final approval changes
-- tax_rates (earlier rows are ended the day before, so past payroll keeps the slabs it used).

CREATE TABLE tax_slab_change_requests (
  id uuid PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  reason text NOT NULL,
  "requestedById" integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX tax_slab_change_requests_scope ON tax_slab_change_requests ("tenantId", action, status);

-- TAX_SLAB_CHANGE_SECURITY (the table above comes from the Prisma schema in the isolated test database)
ALTER TABLE tax_slab_change_requests ADD CONSTRAINT tax_slab_change_requester_fk FOREIGN KEY ("requestedById") REFERENCES "Employee"(id), ADD CONSTRAINT tax_slab_change_action CHECK (action IN ('REPLACE_SET')), ADD CONSTRAINT tax_slab_change_status CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN'));
ALTER TABLE tax_slab_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_slab_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_slab_change_requests_tenant ON tax_slab_change_requests USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on') WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON tax_slab_change_requests FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('TAX_SLAB_CHANGE','status','APPROVED','REJECTED','requestedById','action,payload,reason');

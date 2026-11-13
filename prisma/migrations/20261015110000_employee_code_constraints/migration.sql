BEGIN;
SELECT set_config('app.tenant_bypass','on',true);
-- Apply the report-first employee-code backfill after the preceding migration.
-- Stop on unresolved records; no category or business identifier is guessed.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "Employee" WHERE tenant_id IS NULL OR employee_code IS NULL OR btrim(employee_code)='' OR employee_code<>btrim(employee_code) OR employee_code !~ '^[A-Z0-9]+([-_][A-Z0-9]+)*$') THEN RAISE EXCEPTION 'Run employee-code-backfill.mjs and resolve missing/invalid company and employee codes'; END IF;
 IF EXISTS(SELECT 1 FROM "Employee" GROUP BY tenant_id,regexp_replace(employee_code,'[-_]','','g') HAVING count(*)>1) THEN RAISE EXCEPTION 'Resolve duplicate employee codes, including punctuation variants'; END IF;
END $$;
ALTER TABLE "Employee" ALTER COLUMN employee_code SET NOT NULL;
ALTER TABLE "Employee" ADD CONSTRAINT employee_code_not_blank CHECK (btrim(employee_code)<>'' AND employee_code=btrim(employee_code));
CREATE UNIQUE INDEX "Employee_tenant_id_employee_code_key" ON "Employee"(tenant_id,employee_code);
CREATE UNIQUE INDEX employee_code_collision_key ON "Employee"(tenant_id,regexp_replace(employee_code,'[-_]','','g'));
INSERT INTO "EmployeeCodeReservation" ("tenantId","employeeCode","collisionKey","updatedAt") SELECT tenant_id,employee_code,regexp_replace(employee_code,'[-_]','','g'),now() FROM "Employee" ON CONFLICT ("tenantId","employeeCode") DO NOTHING;

COMMIT;

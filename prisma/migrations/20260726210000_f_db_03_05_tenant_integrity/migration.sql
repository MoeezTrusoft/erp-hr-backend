-- F-DB-03/F-DB-04/F-DB-05: tenant-qualified uniqueness, declared natural
-- keys, and staged tenant-null remediation. This migration is forward-only.

-- Deterministic backfill from authoritative local parents. Conflicting or
-- parentless rows remain NULL for the explicit mapping mechanism; no tenant is
-- guessed. Parent agreement is required where more than one parent can resolve.
UPDATE "DashboardLayout" AS child
SET "tenantId" = parent."tenant_id"
FROM "Employee" AS parent
WHERE child."employeeId" = parent.id
  AND child."tenantId" IS NULL
  AND parent."tenant_id" IS NOT NULL;

UPDATE "leave_policies" AS child
SET "tenantId" = parent."tenant_id"
FROM "Employee" AS parent
WHERE child."createdById" = parent.id
  AND child."tenantId" IS NULL
  AND parent."tenant_id" IS NOT NULL;

UPDATE "approval_workflows" AS child
SET "tenantId" = parent."tenant_id"
FROM "Employee" AS parent
WHERE child."createdById" = parent.id
  AND child."tenantId" IS NULL
  AND parent."tenant_id" IS NOT NULL;

UPDATE "regions" AS child
SET "tenantId" = parent."tenant_id"
FROM "Employee" AS parent
WHERE child."createdById" = parent.id
  AND child."tenantId" IS NULL
  AND parent."tenant_id" IS NOT NULL;

UPDATE "Candidate" AS child
SET "tenantId" = parent."tenant_id"
FROM "Employee" AS parent
WHERE child."createdById" = parent.id
  AND child."tenantId" IS NULL
  AND parent."tenant_id" IS NOT NULL;

UPDATE "TrainingCourse" AS child
SET "tenantId" = parent."tenantId"
FROM "TrainingCategory" AS parent
WHERE child."categoryId" = parent.id
  AND child."tenantId" IS NULL
  AND parent."tenantId" IS NOT NULL;

-- Fail before changing any indexes. The error includes every duplicate group
-- and tells the operator exactly how to unblock the migration.
DO $$
DECLARE
  spec record;
  duplicates jsonb;
  report jsonb := '[]'::jsonb;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('DashboardLayout', '"employeeId", "dashboardType"', 'TRUE'),
      ('leave_policies', '"name"', '"name" IS NOT NULL'),
      ('approval_workflows', '"name"', '"name" IS NOT NULL'),
      ('regions', '"name"', '"name" IS NOT NULL'),
      ('payroll_earning_types', '"code"', '"code" IS NOT NULL'),
      ('payroll_deduction_types', '"code"', '"code" IS NOT NULL'),
      ('Candidate', '"email"', '"email" IS NOT NULL'),
      ('skills', '"name"', '"name" IS NOT NULL'),
      ('TrainingCourse', '"courseCode"', '"courseCode" IS NOT NULL'),
      ('salary_components', '"code"', '"code" IS NOT NULL'),
      ('payroll_calendars', '', 'TRUE'),
      ('payroll_rule_config', '', 'TRUE'),
      ('payroll_config_meta', '', 'TRUE'),
      ('payroll_config_snapshots', '"version"', 'TRUE')
    ) AS keys(table_name, key_columns, predicate)
  LOOP
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(to_jsonb(d)), ''[]''::jsonb) FROM (' ||
      'SELECT "tenantId"%s, count(*) AS rows FROM %I WHERE %s ' ||
      'GROUP BY "tenantId"%s HAVING count(*) > 1) d',
      CASE WHEN spec.key_columns = '' THEN '' ELSE ', ' || spec.key_columns END,
      spec.table_name,
      spec.predicate,
      CASE WHEN spec.key_columns = '' THEN '' ELSE ', ' || spec.key_columns END
    ) INTO duplicates;
    IF jsonb_array_length(duplicates) > 0 THEN
      report := report || jsonb_build_array(jsonb_build_object(
        'table', spec.table_name,
        'keyColumns', spec.key_columns,
        'duplicateGroups', duplicates
      ));
    END IF;
  END LOOP;

  IF jsonb_array_length(report) > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = 'F-DB-03 duplicate preflight failed: ' || report::text,
      DETAIL = 'No unique indexes were changed.',
      HINT = 'Action: resolve the listed duplicate groups within each tenant, then rerun prisma migrate deploy.';
  END IF;
END $$;

DROP INDEX "DashboardLayout_dashboardType_key";
DROP INDEX "leave_policies_name_key";
DROP INDEX "approval_workflows_name_key";
DROP INDEX "regions_name_key";
DROP INDEX "payroll_earning_types_code_key";
DROP INDEX "payroll_deduction_types_code_key";
DROP INDEX "Candidate_email_key";
DROP INDEX "skills_name_key";

CREATE UNIQUE INDEX "DashboardLayout_tenantId_employeeId_dashboardType_key"
  ON "DashboardLayout"("tenantId", "employeeId", "dashboardType");
CREATE UNIQUE INDEX "leave_policies_tenantId_name_key"
  ON "leave_policies"("tenantId", "name");
CREATE UNIQUE INDEX "approval_workflows_tenantId_name_key"
  ON "approval_workflows"("tenantId", "name");
CREATE UNIQUE INDEX "regions_tenantId_name_key"
  ON "regions"("tenantId", "name");
CREATE UNIQUE INDEX "payroll_earning_types_tenantId_code_key"
  ON "payroll_earning_types"("tenantId", "code");
CREATE UNIQUE INDEX "payroll_deduction_types_tenantId_code_key"
  ON "payroll_deduction_types"("tenantId", "code");
CREATE UNIQUE INDEX "Candidate_tenantId_email_key"
  ON "Candidate"("tenantId", "email");
CREATE UNIQUE INDEX "skills_tenantId_name_key"
  ON "skills"("tenantId", "name");
CREATE UNIQUE INDEX "TrainingCourse_tenantId_courseCode_key"
  ON "TrainingCourse"("tenantId", "courseCode");
DROP INDEX "TrainingCourse_courseCode_idx";
CREATE UNIQUE INDEX "salary_components_tenantId_code_key"
  ON "salary_components"("tenantId", "code");
DROP INDEX "salary_components_code_idx";
CREATE UNIQUE INDEX "payroll_calendars_tenantId_key"
  ON "payroll_calendars"("tenantId");
DROP INDEX "payroll_calendars_tenantId_idx";
CREATE UNIQUE INDEX "payroll_rule_config_tenantId_key"
  ON "payroll_rule_config"("tenantId");
DROP INDEX "payroll_rule_config_tenantId_idx";
CREATE UNIQUE INDEX "payroll_config_meta_tenantId_key"
  ON "payroll_config_meta"("tenantId");
DROP INDEX "payroll_config_meta_tenantId_idx";
CREATE UNIQUE INDEX "payroll_config_snapshots_tenantId_version_key"
  ON "payroll_config_snapshots"("tenantId", "version");
DROP INDEX "payroll_config_snapshots_version_idx";

-- F-DB-05 nullable tenant backfill report. NOT VALID keeps legacy rows online,
-- while PostgreSQL enforces the check for every new or changed row. All 112
-- currently nullable tenant models are discovered from the catalog so mapped
-- table names and Employee.tenant_id are covered without an unsafe hard-coded
-- tenant value.
DO $$
DECLARE
  col record;
  constraint_name text;
BEGIN
  FOR col IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('tenantId', 'tenant_id')
      AND is_nullable = 'YES'
    ORDER BY table_name
  LOOP
    constraint_name := col.table_name || '_' || col.column_name || '_tenant_not_null_staged';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('public.%I', col.table_name)::regclass
        AND conname = constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IS NOT NULL) NOT VALID',
        col.table_name,
        constraint_name,
        col.column_name
      );
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.hr_tenant_backfill_report()
RETURNS TABLE(table_name text, tenant_column text, unresolved_rows bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  col record;
  unresolved bigint;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('tenantId', 'tenant_id')
      AND c.is_nullable = 'YES'
    ORDER BY c.table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IS NULL', col.table_name, col.column_name)
      INTO unresolved;
    table_name := col.table_name;
    tenant_column := col.column_name;
    unresolved_rows := unresolved;
    RETURN NEXT;
  END LOOP;
END $$;

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const pg = createRequire(
  createRequire(import.meta.url).resolve("@prisma/adapter-pg"),
)("pg");

const pkg = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
const service = pkg.name === "erp-hr-backend" ? "hr" : "pm";
const raw = process.env.ASSESSMENT_TEST_ADMIN_URL;
if (!raw)
  throw new Error(
    "ASSESSMENT_TEST_ADMIN_URL must name a disposable local test database",
  );
const url = new URL(raw);
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  url.pathname !== `/${service}_task_assessment_test`
)
  throw new Error("Refusing a non-local or non-assessment test database");
if (!process.argv.includes("--reset"))
  throw new Error("Pass --reset to recreate only this disposable test schema");
const generated = spawnSync(
  process.execPath,
  [
    "node_modules/prisma/build/index.js",
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema",
    "prisma/schema.prisma",
    "--script",
  ],
  {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, DATABASE_URL: raw },
  },
);
if (generated.status !== 0)
  throw new Error(generated.stderr || "Test schema generation failed");
const db = new pg.Client({ connectionString: raw });
await db.connect();
try {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.query(generated.stdout);
  await db.query(
    `CREATE FUNCTION public.${service}_current_tenant() RETURNS ${service === "hr" ? "uuid" : "integer"} LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::${service === "hr" ? "uuid" : "integer"} $$;`,
  );
  const migration =
    service === "hr"
      ? "20261015000000_hr_task_assessment_v21"
      : "20261015000000_task_assessment_planning";
  const first = await readFile(
    `prisma/migrations/${migration}/migration.sql`,
    "utf8",
  );
  const marker = first.indexOf("-- Assessment ");
  if (marker < 0) throw new Error("Assessment guard section missing");
  await db.query(first.slice(marker));
  const second = await readFile(
    `prisma/migrations/${service === "hr" ? "20261015010000_assessment_integrity_guards" : "20261015010000_assessment_capacity_guards"}/migration.sql`,
    "utf8",
  );
  await db.query(
    service === "hr"
      ? second
      : second.slice(
          second.indexOf('ALTER TABLE "AssessmentToolAllocation" ENABLE'),
        ),
  );
  if (service === "hr")
    await db.query(
      await readFile(
        "prisma/migrations/20261015020000_assessment_insert_freeze/migration.sql",
        "utf8",
      ),
    );
  const employment = await readFile(
    "prisma/migrations/20261015100000_employee_codes_and_separation/migration.sql",
    "utf8",
  );
  await db.query(
    employment.slice(employment.indexOf("-- Employment security guards")),
  );
  const setup=await readFile('prisma/migrations/20261016120000_hr_company_setup/migration.sql','utf8');
  await db.query(setup.slice(setup.indexOf('-- SETUP_SECURITY')));
  const tracker=await readFile('prisma/migrations/20261017090000_hr_setup_action_tracker/migration.sql','utf8');
  await db.query(tracker.slice(tracker.indexOf('-- TRACKER_SECURITY')));
  const approvals=await readFile('prisma/migrations/20261015120000_hr_approval_workflow/migration.sql','utf8');
  await db.query(approvals.slice(approvals.indexOf('-- Approval security guards')));
  const workspace=await readFile('prisma/migrations/20261020090000_attendance_workspace/migration.sql','utf8');
  await db.query(workspace.slice(workspace.indexOf('-- WORKSPACE_SECURITY')));
  const acceptance=await readFile('prisma/migrations/20261020120000_attendance_onsite_acceptance/migration.sql','utf8');
  await db.query(acceptance.slice(acceptance.indexOf('-- ACCEPTANCE_SECURITY')).replace(/ALTER TABLE attendance_capture_devices ADD COLUMN[^;]+;/g,''));
  const correction=await readFile('prisma/migrations/20261019090000_attendance_correction_workflow/migration.sql','utf8');
  await db.query(correction.slice(correction.indexOf('CREATE UNIQUE INDEX attendance_correction_active')));
  const finance=await readFile('prisma/migrations/20261017020000_payroll_finance_summary/migration.sql','utf8');
  await db.query(finance.slice(finance.indexOf('-- PAYROLL_FINANCE_SECURITY')));
  await db.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='assessment_test_user') THEN CREATE ROLE assessment_test_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$; ALTER ROLE assessment_test_user PASSWORD 'assessment-local-test'; GRANT USAGE ON SCHEMA public TO assessment_test_user; GRANT ALL ON ALL TABLES IN SCHEMA public TO assessment_test_user; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO assessment_test_user;",
  );
  process.stdout.write(
    `${service.toUpperCase()} assessment schema and FORCE RLS guards prepared for the non-owner test role.\n`,
  );
} finally {
  await db.end();
}

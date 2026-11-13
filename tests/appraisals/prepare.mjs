// Fixed disposable loopback database only. Never reset an existing schema.
import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
const base = "postgresql://appraisal_admin@127.0.0.1:55443/";
const admin = new pg.Client({ connectionString: base + "postgres" });
await admin.connect();
try {
  if (
    !(
      await admin.query(
        "SELECT 1 FROM pg_database WHERE datname='performance_appraisals_test'",
      )
    ).rowCount
  )
    await admin.query("CREATE DATABASE performance_appraisals_test");
} finally {
  await admin.end();
}
const db = new pg.Client({
  connectionString: base + "performance_appraisals_test",
});
const schema = join(tmpdir(), "appraisal-baseline-" + randomUUID() + ".prisma");
await db.connect();
try {
  if (
    (
      await db.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema='public' LIMIT 1",
      )
    ).rowCount
  )
    throw new Error(
      "Disposable appraisal database already has a schema; refusing destructive reset",
    );
  const baseline = spawnSync(
    "git",
    ["show", "9c882c9d9b607b899dc0c4d1f2313d13f8d615ad:prisma/schema.prisma"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (baseline.status !== 0) throw new Error(baseline.stderr);
  await writeFile(schema, baseline.stdout);
  const generated = spawnSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "diff",
      "--from-empty",
      "--to-schema",
      schema,
      "--script",
    ],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        DATABASE_URL: base + "performance_appraisals_test",
      },
    },
  );
  if (generated.status !== 0) throw new Error(generated.stderr);
  await db.query("BEGIN");
  await db.query(generated.stdout);
  await db.query(
    "CREATE FUNCTION public.hr_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$",
  );
  for (const name of [
    "20261026000000_performance_appraisals",
    "20261026010000_appraisal_integrity",
    "20261026020000_appraisal_corrections",
    "20261026030000_appraisal_scheduling",
    "20261026040000_appraisal_approval_bridge",
    "20261026050000_appraisal_launch_journal",
    "20261026060000_appraisal_peer_feedback",
    // Employee.attendance_only: the current Prisma client selects it, the pinned baseline predates it.
    "20261029090000_employee_attendance_only",
    // Employee.tax_exempt: same reason (the client selects it, the baseline predates it).
    "20261102120000_employee_tax_exempt",
    "20261029120000_payroll_cash_disbursement",
    // HrApprovalRequest.route / level / pendingCodes and the approval matrix table.
    "20261030090000_approval_matrix",
  ])
    await db.query(
      await readFile(`prisma/migrations/${name}/migration.sql`, "utf8"),
    );
  await db.query(
    "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='appraisal_runtime') THEN CREATE ROLE appraisal_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$; GRANT USAGE ON SCHEMA public TO appraisal_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO appraisal_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO appraisal_runtime;",
  );
  await db.query("COMMIT");
  console.log(
    "Pinned baseline and exact migrations installed for the restricted runtime role",
  );
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
} finally {
  await db.end();
  await unlink(schema).catch(() => {});
}

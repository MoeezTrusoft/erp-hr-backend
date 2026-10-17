import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";

test("payroll upgrade preserves posted debt and allows replacement only after cancellation", async () => {
  const url = new URL(
    process.env.ASSESSMENT_TEST_ADMIN_URL || "http://invalid",
  );
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/hr_task_assessment_test");
  const schema = "payroll_upgrade_" + randomUUID().replaceAll("-", "");
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    const tenant = randomUUID();
    await db.query(`CREATE TABLE payroll_runs(id SERIAL PRIMARY KEY,"tenantId" UUID,"periodStart" TIMESTAMP,"periodEnd" TIMESTAMP,status TEXT);
      CREATE UNIQUE INDEX "payroll_runs_tenantId_periodStart_periodEnd_key" ON payroll_runs("tenantId","periodStart","periodEnd");
      CREATE TABLE payroll_payslips(id SERIAL PRIMARY KEY);
      CREATE TABLE loan_repayments(id SERIAL PRIMARY KEY,"tenantId" UUID NOT NULL DEFAULT '${tenant}',"deductedAt" TIMESTAMP NOT NULL);
      INSERT INTO loan_repayments("deductedAt") VALUES ('2026-09-30');
      ALTER TABLE loan_repayments ENABLE ROW LEVEL SECURITY;
      ALTER TABLE loan_repayments FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON loan_repayments USING (
        "tenantId"=NULLIF(current_setting('app.tenant_id',true),'')::uuid
        OR current_setting('app.tenant_bypass',true)='on'
      );
      GRANT USAGE, CREATE ON SCHEMA "${schema}" TO assessment_test_user;
      ALTER TABLE payroll_runs OWNER TO assessment_test_user;
      ALTER TABLE payroll_payslips OWNER TO assessment_test_user;
      ALTER TABLE loan_repayments OWNER TO assessment_test_user;
      SET ROLE assessment_test_user;`);
    assert.equal(
      (await db.query('SELECT count(*)::int AS count FROM loan_repayments')).rows[0].count,
      0,
      'The migration role must be subject to FORCE RLS',
    );
    await db.query(
      await readFile(
        new URL(
          "../../prisma/migrations/20261017190000_payroll_workflow_controls/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.notEqual(
      (await db.query("SELECT current_setting('app.tenant_bypass',true) AS bypass")).rows[0].bypass,
      'on',
      'Migration must not leave cross-tenant access enabled',
    );
    await db.query("SELECT set_config('app.tenant_id',$1,false)", [tenant]);
    const old = (
      await db.query(
        'SELECT "settledAt"="deductedAt" AS preserved FROM loan_repayments',
      )
    ).rows[0];
    assert.equal(old.preserved, true);
    await db.query(
      `INSERT INTO loan_repayments("deductedAt") VALUES ('2026-10-31')`,
    );
    assert.equal(
      (await db.query('SELECT "settledAt" FROM loan_repayments WHERE id=2'))
        .rows[0].settledAt,
      null,
    );
    const insert = () =>
      db.query(
        `INSERT INTO payroll_runs("tenantId","periodStart","periodEnd",status) VALUES($1,'2026-09-01','2026-09-30','PENDING')`,
        [tenant],
      );
    await insert();
    await assert.rejects(insert(), (e) => e.code === "23505");
    await db.query("UPDATE payroll_runs SET status='CANCELLED'");
    await insert();
    assert.equal(
      (await db.query("SELECT count(*)::int AS count FROM payroll_runs"))
        .rows[0].count,
      2,
    );
  } finally {
    await db.query('RESET ROLE');
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  }
});

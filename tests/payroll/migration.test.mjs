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
    await db.query(`CREATE TABLE payroll_runs(id SERIAL PRIMARY KEY,"tenantId" UUID,"periodStart" TIMESTAMP,"periodEnd" TIMESTAMP,status TEXT);
      CREATE UNIQUE INDEX "payroll_runs_tenantId_periodStart_periodEnd_key" ON payroll_runs("tenantId","periodStart","periodEnd");
      CREATE TABLE payroll_payslips(id SERIAL PRIMARY KEY);
      CREATE TABLE loan_repayments(id SERIAL PRIMARY KEY,"deductedAt" TIMESTAMP NOT NULL);
      INSERT INTO loan_repayments("deductedAt") VALUES ('2026-09-30');`);
    await db.query(
      await readFile(
        new URL(
          "../../prisma/migrations/20261017190000_payroll_workflow_controls/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
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
    const tenant = randomUUID();
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
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  }
});

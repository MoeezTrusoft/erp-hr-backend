import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const exec = promisify(execFile);
const pg = createRequire(
  createRequire(import.meta.url).resolve("@prisma/adapter-pg"),
)("pg");
const raw = process.env.ASSESSMENT_TEST_ADMIN_URL;
const enabled = Boolean(raw);
if (
  enabled &&
  (!["127.0.0.1", "localhost"].includes(new URL(raw).hostname) ||
    new URL(raw).pathname !== "/hr_task_assessment_test")
)
  throw new Error("Use the isolated local test admin URL");

test(
  "additive migrations and report-first backfill preserve legacy codes and rerun safely",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const database = "hr_employment_migration_test";
    const admin = new pg.Client({ connectionString: raw });
    await admin.connect();
    // Fixed local test name; never delete an existing database on entry.
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(raw);
    url.pathname = "/" + database;
    const db = new pg.Client({ connectionString: url.href });
    const folder = await mkdtemp(join(tmpdir(), "hr-code-migration-"));
    try {
      await db.connect();
      await db.query(`
      CREATE FUNCTION hr_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$;
      CREATE TABLE "Employee" (id serial PRIMARY KEY, tenant_id uuid, employee_code text, hire_date date, joining_date date, version integer NOT NULL DEFAULT 1, updated_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE "AssessmentCodeChange" (id uuid PRIMARY KEY, "tenantId" uuid, "oldCode" text, "newCode" text);
    `);
      const company = randomUUID(),
        other = randomUUID();
      await db.query(
        `INSERT INTO "Employee" (tenant_id,employee_code,hire_date) VALUES ($1,'EMP-0007','2020-01-01'),($1,NULL,'2022-02-02'),($1,'','2021-01-01'),($1,NULL,'2023-03-03'),($2,NULL,'2019-01-01')`,
        [company, other],
      );
      await db.query(
        await readFile(
          new URL(
            "../../prisma/migrations/20261015100000_employee_codes_and_separation/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const mapping = [1, 2, 3].map((legacyRowId) => ({
        companyUuid: company,
        legacyRowId,
        category: "EMPLOYEE",
      }));
      const mappingPath = join(folder, "categories.json");
      await writeFile(mappingPath, JSON.stringify(mapping));
      const run = async (...extra) => {
        const result = await exec(
          process.execPath,
          [
            "scripts/employee-code-backfill.mjs",
            "--company",
            company,
            "--category-map",
            mappingPath,
            ...extra,
          ],
          {
            cwd: new URL("../../", import.meta.url),
            env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href },
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
      };
      const report = await run();
      assert.equal(report.applied, false);
      assert.deepEqual(
        report.planned.map((p) => p.legacyRowId),
        [3, 2],
      );
      assert.ok(
        report.issues.some(
          (i) => i.legacyRowId === 4 && i.kind === "UNKNOWN_CATEGORY",
        ),
      );
      assert.equal(
        (await db.query('SELECT employee_code FROM "Employee" WHERE id=2'))
          .rows[0].employee_code,
        null,
      );
      const applied = await run("--apply");
      assert.deepEqual(
        applied.planned.map((p) => p.employeeCode),
        ["EMP-0008", "EMP-0009"],
      );
      const first = (
        await db.query(
          'SELECT id,employee_code,"employeeCategory",version FROM "Employee" ORDER BY id',
        )
      ).rows;
      assert.equal(first[0].employee_code, "EMP-0007");
      assert.equal(first[3].employee_code, null);
      assert.equal(first[4].employee_code, null);
      assert.equal((await run("--apply")).planned.length, 0);
      assert.deepEqual(
        (
          await db.query(
            'SELECT id,employee_code,"employeeCategory",version FROM "Employee" ORDER BY id',
          )
        ).rows,
        first,
      );
      const final = await readFile(
        new URL(
          "../../prisma/migrations/20261015110000_employee_code_constraints/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await assert.rejects(db.query(final), /resolve missing\/invalid/);
      await db.query("ROLLBACK");
      // Explicitly resolve the remaining fictional identities before enforcement.
      await db.query(
        `UPDATE "Employee" SET employee_code='INTR-0001',"employeeCategory"='INTERNEE' WHERE id IN (4,5)`,
      );
      await db.query(final);
      await assert.rejects(
        db.query(
          `INSERT INTO "Employee"(tenant_id,employee_code,"employeeCategory") VALUES($1,NULL,'EMPLOYEE')`,
          [company],
        ),
        /mandatory/,
      );
      await assert.rejects(
        db.query(
          `INSERT INTO "Employee"(tenant_id,employee_code,"employeeCategory") VALUES($1,'EMP_0007','EMPLOYEE')`,
          [company],
        ),
        /duplicate/,
      );
      await assert.rejects(
        db.query(`UPDATE "Employee" SET tenant_id=$1 WHERE id=1`, [other]),
        /immutable/,
      );
      await assert.rejects(
        db.query(`DELETE FROM "EmployeeCodeReservation" WHERE "tenantId"=$1`, [
          company,
        ]),
        /immutable/,
      );
    } finally {
      await db.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
      if (
        dirname(resolve(folder)) !== resolve(tmpdir()) ||
        !basename(folder).startsWith("hr-code-migration-")
      )
        throw new Error("Unsafe temporary directory");
      await rm(folder, { recursive: true, force: true });
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";

test(
  "upgrade migrations install guards and quarantine only unsigned unrepaid loans",
  { timeout: 180000 },
  async () => {
    const url = new URL(
      process.env.ASSESSMENT_TEST_ADMIN_URL || "http://invalid",
    );
    if (
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/hr_task_assessment_test"
    )
      throw new Error("Use the isolated local HR test database admin");
    const name = "hr_approval_upgrade_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const dir = await mkdtemp(join(tmpdir(), "hr-approval-migration-"));
    let db,
      created = false;
    try {
      let schema = await readFile("prisma/schema.prisma", "utf8");
      schema = schema
        .replace(
          /model HrApproval(?:Request|Audit|Receipt) \{[\s\S]*?\n\}/g,
          "",
        )
        // The pre-approval snapshot cannot retain relations to removed models.
        .replace(/^\s*\w+\s+HrApproval(?:Request|Audit|Receipt)(?:\[\]|\?)?[^\n]*$/gm, "")
        .replace(/enum LoanStatus \{[\s\S]*?\n\}/, (block) =>
          block.replace(/\n\s+(PENDING|REJECTED)\b/g, ""),
        )
        .replace(/model Loan \{[\s\S]*?\n\}/, (block) =>
          block.replace("@default(PENDING)", "@default(ACTIVE)"),
        )
        .replace(/model AttendanceTimeCredit \{[\s\S]*?\n\}/, (block) =>
          block.replace('@default("PENDING")', '@default("APPROVED")'),
        );
      const path = join(dir, "before.prisma");
      await writeFile(path, schema);
      const diff = spawnSync(
        process.execPath,
        [
          "node_modules/prisma/build/index.js",
          "migrate",
          "diff",
          "--from-empty",
          "--to-schema",
          path,
          "--script",
        ],
        {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, DATABASE_URL: url.toString() },
        },
      );
      assert.equal(diff.status, 0, diff.stderr);
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      url.pathname = "/" + name;
      db = new pg.Client({ connectionString: url.toString() });
      await db.connect();
      await db.query(diff.stdout);
      await db.query(
        "CREATE FUNCTION public.hr_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$",
      );
      const company = randomUUID();
      const person = (
        await db.query(
          "INSERT INTO \"Employee\" (tenant_id,employee_code,\"employeeCategory\",updated_at) VALUES ($1,'EMP-TEST','EMPLOYEE',now()) RETURNING id",
          [company],
        )
      ).rows[0].id;
      const loans = [];
      for (let i = 0; i < 3; i++)
        loans.push(
          (
            await db.query(
              'INSERT INTO loans ("tenantId","employeeId","principalMinor","outstandingMinor","tenureMonths","monthlyInstallmentMinor","disbursementDate","approvedById",updated_at) VALUES ($1,$2,100,100,1,100,now(),$3,now()) RETURNING id',
              [company, person, i === 2 ? person : null],
            )
          ).rows[0].id,
        );
      await db.query(
        'INSERT INTO loan_repayments ("tenantId","loanId","amountMinor") VALUES ($1,$2,10)',
        [company, loans[1]],
      );
      // Separate commits are required before PostgreSQL can use a new enum value.
      for (const migration of [
        "20261015115900_hr_approval_loan_states",
        "20261015120000_hr_approval_workflow",
      ])
        await db.query(
          await readFile(
            `prisma/migrations/${migration}/migration.sql`,
            "utf8",
          ),
        );
      assert.deepEqual(
        (await db.query("SELECT status FROM loans ORDER BY id")).rows.map(
          (r) => r.status,
        ),
        ["PENDING", "ACTIVE", "ACTIVE"],
      );
      const rows = (
        await db.query(
          "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('HrApprovalRequest','HrApprovalAudit','HrApprovalReceipt')",
        )
      ).rows;
      assert.equal(rows.length, 3);
      assert.ok(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity));
      await assert.rejects(
        db.query("UPDATE loans SET status='ACTIVE' WHERE id=$1", [loans[0]]),
        /staged approval/,
      );
    } finally {
      await db?.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
      // mkdtemp returned this task-owned directory; remove its sole generated file.
      await rm(join(dir, "before.prisma"), { force: true });
      await rmdir(dir);
    }
  },
);

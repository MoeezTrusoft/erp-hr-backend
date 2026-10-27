import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
test(
  "complete migration preserves existing live devices and guards new activation",
  { skip: !process.env.ASSESSMENT_TEST_ADMIN_URL },
  async () => {
    const url = new URL(process.env.ASSESSMENT_TEST_ADMIN_URL);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/hr_task_assessment_test");
    const db = new pg.Client({ connectionString: url.href });
    await db.connect();
    try {
      await db.query("BEGIN");
      const schema = "oat_probe_" + randomUUID().replaceAll("-", "");
      await db.query(
        `CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public`,
      );
      await db.query(
        "CREATE TABLE attendance_capture_devices (LIKE public.attendance_capture_devices INCLUDING DEFAULTS)",
      );
      await db.query(
        'ALTER TABLE attendance_capture_devices DROP COLUMN "acceptanceSiteRef", DROP COLUMN "acceptanceMode", ALTER COLUMN active SET DEFAULT true',
      );
      const id = randomUUID(),
        tenant = randomUUID();
      await db.query(
        'INSERT INTO attendance_capture_devices (id,"tenantId",sn,name,"timeZone","allowedTenantIds","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,now())',
        [id, tenant, "MIGRATION-ONLY", "Probe", "Asia/Karachi", [tenant]],
      );
      await db.query(
        await readFile(
          new URL(
            "../../prisma/migrations/20261020120000_attendance_onsite_acceptance/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      assert.equal(
        (await db.query("SELECT active FROM attendance_capture_devices"))
          .rows[0].active,
        true,
      );
      assert.equal(
        (
          await db.query(
            "SELECT column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3",
            [schema, "attendance_capture_devices", "active"],
          )
        ).rows[0].column_default,
        "false",
      );
      await db.query("UPDATE attendance_capture_devices SET active=false");
      await db.query("SAVEPOINT invalid_enable");
      await assert.rejects(
        db.query("UPDATE attendance_capture_devices SET active=true"),
        /Management-approved onsite acceptance/,
      );
      await db.query("ROLLBACK TO SAVEPOINT invalid_enable");
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relrowsecurity AND c.relforcerowsecurity",
            [schema],
          )
        ).rows[0].n,
        3,
      );
    } finally {
      await db.query("ROLLBACK");
      await db.end();
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

test(
  "Production appraisal migrations apply unchanged to the pinned pre-appraisal schema",
  { timeout: 90000 },
  async () => {
    const database =
      "performance_appraisals_migration_" + randomUUID().replaceAll("-", "");
    assert.match(database, /^performance_appraisals_migration_[a-f0-9]{32}$/);
    const url = "postgresql://appraisal_admin@127.0.0.1:55443/";
    const admin = new pg.Client({ connectionString: url + "postgres" });
    await admin.connect();
    const schemaFile = join(tmpdir(), database + ".prisma");
    let db;
    try {
      const baseline = spawnSync(
        "git",
        [
          "show",
          "9c882c9d9b607b899dc0c4d1f2313d13f8d615ad:prisma/schema.prisma",
        ],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
      assert.equal(baseline.status, 0, baseline.stderr);
      await writeFile(schemaFile, baseline.stdout);
      const sql = spawnSync(
        process.execPath,
        [
          "node_modules/prisma/build/index.js",
          "migrate",
          "diff",
          "--from-empty",
          "--to-schema",
          schemaFile,
          "--script",
        ],
        {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, DATABASE_URL: url + "postgres" },
        },
      );
      assert.equal(sql.status, 0, sql.stderr);
      await admin.query(`CREATE DATABASE "${database}"`);
      db = new pg.Client({ connectionString: url + database });
      await db.connect();
      await db.query(sql.stdout);
      for (const name of [
        "20261026000000_performance_appraisals",
        "20261026010000_appraisal_integrity",
        "20261026020000_appraisal_corrections",
        "20261026030000_appraisal_scheduling",
        "20261026040000_appraisal_approval_bridge",
        "20261026050000_appraisal_launch_journal",
        "20261026060000_appraisal_peer_feedback",
      ]) {
        await db.query("BEGIN");
        await db.query(
          await readFile(`prisma/migrations/${name}/migration.sql`, "utf8"),
        );
        await db.query("COMMIT");
      }
      const tables = await db.query(
        `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname LIKE 'Perf%' AND relname NOT LIKE 'Performance%'`,
      );
      assert.equal(tables.rowCount, 26);
      assert.ok(
        tables.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity),
      );
      const triggers = await db.query(
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('perf_review_guard','perf_response_frozen','perf_template_frozen','perf_closing_snapshot_guard','perf_legacy_review_guard')`,
      );
      assert.equal(triggers.rowCount, 5);
    } finally {
      if (db) await db.end();
      // Fixed loopback test administrator, generated prefix and exact identifier only.
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end();
      await unlink(schemaFile).catch(() => {});
    }
  },
);

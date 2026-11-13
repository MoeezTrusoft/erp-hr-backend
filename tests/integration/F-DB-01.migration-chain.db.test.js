import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import "dotenv/config";
import { Client } from "pg";

const rootDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = rootDatabaseUrl ? describe : describe.skip;

function runPrisma(args, databaseUrl) {
  return spawnSync(process.execPath, ["node_modules/prisma/build/index.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

function runIndexPostDeploy(databaseUrl) {
  // F-DB-06/F-DB-07/F-DB-08: concurrent indexes are deliberately outside the
  // Prisma transaction, but remain a required, replayable deployment phase.
  return spawnSync(process.execPath, ["scripts/apply-hr-indexes.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_DIRECT_URL: databaseUrl },
  });
}

describeDatabase("F-DB-01/F-DB-02 migration chain", () => {
  test("deploys from zero and matches the current Prisma schema", async () => {
    const databaseName = `hr_migration_chain_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(rootDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const databaseUrl = new URL(rootDatabaseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const admin = new Client({ connectionString: adminUrl.toString() });

    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);

      const deploy = runPrisma(["migrate", "deploy"], databaseUrl.toString());
      if (deploy.status !== 0) {
        throw new Error(`prisma migrate deploy failed:\n${deploy.stdout}\n${deploy.stderr}`);
      }

      const indexes = runIndexPostDeploy(databaseUrl.toString());
      if (indexes.status !== 0) {
        throw new Error(`index post-deploy failed:\n${indexes.stdout}\n${indexes.stderr}`);
      }

      const diff = runPrisma(
        [
          "migrate",
          "diff",
          "--exit-code",
          "--from-config-datasource",
          "--to-schema",
          "prisma/schema.prisma",
        ],
        databaseUrl.toString(),
      );
      if (diff.status !== 0) {
        throw new Error(`prisma migrate diff failed:\n${diff.stdout}\n${diff.stderr}`);
      }
      expect(`${diff.stdout}\n${diff.stderr}`).toMatch(/No difference detected/i);
    } finally {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  }, 180_000);
});

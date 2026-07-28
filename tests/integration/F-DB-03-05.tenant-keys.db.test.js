import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

describeDatabase("F-DB-03/F-DB-04 two-tenant natural keys", () => {
  let admin;
  let db;
  let databaseName;

  beforeAll(async () => {
    databaseName = `hr_tenant_keys_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(rootDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const databaseUrl = new URL(rootDatabaseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const deploy = runPrisma(["migrate", "deploy"], databaseUrl.toString());
    if (deploy.status !== 0) {
      throw new Error(`prisma migrate deploy failed:\n${deploy.stdout}\n${deploy.stderr}`);
    }
    db = new Client({ connectionString: databaseUrl.toString() });
    await db.connect();
  }, 180_000);

  afterAll(async () => {
    try { await db?.end(); } catch {}
    if (admin) {
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseName],
        );
      } catch {}
      try { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); } catch {}
      try { await admin.end(); } catch {}
    }
  }, 60_000);

  test.each([
    ["payroll_earning_types", "code", "BASE", "name, type", "'Base salary', 'EARNING'", "updated_at"],
    ["payroll_deduction_types", "code", "TAX", "name, type", "'Tax', 'DEDUCTION'", "updated_at"],
    ["Candidate", "email", "same@example.test", "\"firstName\"", "'Sam'", "updatedAt"],
    ["skills", "name", "PostgreSQL", "category", "'skill'", null],
    ["salary_components", "code", "BASIC", "name, type", "'Basic', 'EARNING'", "updatedAt"],
  ])("allows %s.%s in two tenants and rejects a same-tenant duplicate", async (table, key, value, columns, values, updatedColumn) => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const quotedTable = `"${table}"`;
    const quotedKey = `"${key}"`;
    const timestampColumn = updatedColumn ? `, "${updatedColumn}"` : "";
    const timestampValue = updatedColumn ? ", CURRENT_TIMESTAMP" : "";
    await db.query(
      `INSERT INTO ${quotedTable} ("tenantId", ${quotedKey}, ${columns}${timestampColumn}) ` +
        `VALUES ($1, $2, ${values}${timestampValue}), ($3, $2, ${values}${timestampValue})`,
      [tenantA, value, tenantB],
    );
    await expect(
      db.query(
        `INSERT INTO ${quotedTable} ("tenantId", ${quotedKey}, ${columns}${timestampColumn}) ` +
          `VALUES ($1, $2, ${values}${timestampValue})`,
        [tenantA, value],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  test.each(["payroll_calendars", "payroll_rule_config", "payroll_config_meta"])(
    "%s is a singleton per tenant",
    async (table) => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      await db.query(`INSERT INTO "${table}" ("tenantId", "updatedAt") VALUES ($1, CURRENT_TIMESTAMP), ($2, CURRENT_TIMESTAMP)`, [tenantA, tenantB]);
      await expect(db.query(`INSERT INTO "${table}" ("tenantId", "updatedAt") VALUES ($1, CURRENT_TIMESTAMP)`, [tenantA])).rejects.toMatchObject({
        code: "23505",
      });
    },
  );

  test("snapshot versions are unique within, not across, tenants", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await db.query(
      `INSERT INTO "payroll_config_snapshots" ("tenantId", "version", "config") VALUES ($1, 1, '{}'), ($2, 1, '{}')`,
      [tenantA, tenantB],
    );
    await expect(
      db.query(
        `INSERT INTO "payroll_config_snapshots" ("tenantId", "version", "config") VALUES ($1, 1, '{}')`,
        [tenantA],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  test("duplicate preflight aborts with an actionable report before index changes", async () => {
    const tenantId = randomUUID();
    await db.query('DROP INDEX "skills_tenantId_name_key"');
    await db.query(
      'INSERT INTO "skills" ("tenantId", "name") VALUES ($1, $2), ($1, $2)',
      [tenantId, "Duplicate skill"],
    );
    const migration = readFileSync(
      "prisma/migrations/20260726210000_f_db_03_05_tenant_integrity/migration.sql",
      "utf8",
    );

    await expect(db.query(migration)).rejects.toMatchObject({
      message: expect.stringContaining("F-DB-03 duplicate preflight failed"),
      hint: expect.stringContaining("resolve the listed duplicate groups"),
    });
  });
});

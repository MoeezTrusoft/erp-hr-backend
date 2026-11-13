// F-DB-06/F-DB-07/F-DB-08/F-DB-14; ARCH-01 §5.5.
// Executes the index file through psql so every CONCURRENTLY statement runs in
// autocommit, outside Prisma's transactional migration mechanism.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("F-DB-06 index deploy requires DATABASE_DIRECT_URL or DATABASE_URL");
if (/pgbouncer=true/i.test(databaseUrl)) {
  throw new Error("F-DB-06 index deploy requires a direct PostgreSQL URL, not PgBouncer");
}

const sqlFile = fileURLToPath(new URL("./sql/F-DB-06-08-14.hr-indexes.sql", import.meta.url));
const result = spawnSync("psql", [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-f", sqlFile], {
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status || 1;

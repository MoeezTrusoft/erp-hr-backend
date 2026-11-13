// This helper can reach only the disposable loopback appraisal test database.
import { readFile } from "node:fs/promises";
import pg from "pg";
const name = process.argv[2];
if (!/^20261026\d{6}_[a-z_]+$/.test(name || ""))
  throw new Error("Expected an appraisal migration directory name");
const db = new pg.Client({
  connectionString:
    "postgresql://appraisal_admin@127.0.0.1:55443/performance_appraisals_test",
});
await db.connect();
try {
  await db.query("BEGIN");
  await db.query(
    await readFile(`prisma/migrations/${name}/migration.sql`, "utf8"),
  );
  await db.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO appraisal_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO appraisal_runtime",
  );
  await db.query("COMMIT");
  console.log("Applied to disposable local test database:", name);
} catch (e) {
  await db.query("ROLLBACK");
  throw e;
} finally {
  await db.end();
}

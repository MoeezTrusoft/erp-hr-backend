// F-DB-06/F-DB-07/F-DB-08/F-DB-14; ARCH-01 §5.5.
// Executes the index file through psql so every CONCURRENTLY statement runs in
// autocommit, outside Prisma's transactional migration mechanism.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sqlFile = fileURLToPath(new URL("./sql/F-DB-06-08-14.hr-indexes.sql", import.meta.url));
export function deployIndexes({ env = process.env, run = spawnSync } = {}) {
  const databaseUrl = env.DATABASE_DIRECT_URL || env.DATABASE_URL;
  if (!databaseUrl) throw new Error("F-DB-06 index deploy requires DATABASE_DIRECT_URL or DATABASE_URL");
  if (/pgbouncer=true/i.test(databaseUrl)) {
    throw new Error("F-DB-06 index deploy requires a direct PostgreSQL URL, not PgBouncer");
  }
  let url;
  try { url = new URL(databaseUrl); }
  catch { throw new Error('F-DB-06 invalid PostgreSQL connection URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('F-DB-06 requires a PostgreSQL URL');
  // PGDATABASE is a database name, not an expanded connection URI. Keep the
  // password in the child environment and pass each libpq setting explicitly.
  const connection = { ...env, PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) };
  const options = { sslmode: 'PGSSLMODE', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY',
    sslrootcert: 'PGSSLROOTCERT', sslcrl: 'PGSSLCRL', sslcrldir: 'PGSSLCRLDIR',
    connect_timeout: 'PGCONNECT_TIMEOUT', application_name: 'PGAPPNAME',
    options: 'PGOPTIONS', channel_binding: 'PGCHANNELBINDING',
    target_session_attrs: 'PGTARGETSESSIONATTRS', gssencmode: 'PGGSSENCMODE' };
  for (const [name, value] of url.searchParams) {
    if (name === 'schema' && value === 'public') continue;
    if (name === 'pgbouncer' && value === 'false') continue;
    if (!Object.hasOwn(options, name)) throw new Error('F-DB-06 unsupported PostgreSQL connection parameter');
    connection[options[name]] = value;
  }
  if (!connection.PGHOST || !connection.PGDATABASE || !connection.PGUSER) {
    throw new Error('F-DB-06 connection requires host, database and user');
  }
  // Never put credentials in argv: a missing executable previously exposed
  // the complete URL in spawnargs.
  const result = run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", sqlFile], {
    stdio: "inherit", env: connection,
  });
  if (result.error) throw new Error("F-DB-06 could not launch psql; ensure the PostgreSQL client is installed");
  return result.status === 0 ? 0 : (result.status || 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = deployIndexes();
}

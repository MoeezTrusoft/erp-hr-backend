import { spawnSync } from 'node:child_process';
import pg from 'pg';

// Build the disposable database from the same migration chain used in deployment.
// Replaying guard fragments on a Prisma-generated schema duplicates named indexes
// and foreign keys now that those constraints are represented in schema.prisma.
export async function prepareFullHrDatabase(raw, reset) {
  const url = new URL(raw);
  if (!reset || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/hr_task_assessment_test') {
    throw new Error('Reset is restricted to the disposable loopback HR assessment database');
  }
  const db = new pg.Client({ connectionString: raw });
  await db.connect();
  try {
    await db.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='erp') THEN CREATE ROLE erp NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='hr_app') THEN CREATE ROLE hr_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='assessment_test_user') THEN CREATE ROLE assessment_test_user LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF;
    END $$;`);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    for (const args of [
      ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
      ['scripts/apply-hr-indexes.js'],
    ]) {
      const result = spawnSync(process.execPath, args, {
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, DATABASE_URL: raw, DATABASE_DIRECT_URL: raw },
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Test migration failed');
      process.stdout.write(result.stdout);
    }
    await db.query(`ALTER ROLE assessment_test_user LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'assessment-local-test';
      GRANT USAGE ON SCHEMA public TO assessment_test_user;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO assessment_test_user;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO assessment_test_user;`);
    const { rows } = await db.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='assessment_test_user'");
    if (rows.length !== 1 || rows[0].rolsuper || rows[0].rolbypassrls) throw new Error('Test role must not bypass tenant RLS');
    process.stdout.write('Full HR migration chain prepared for the restricted assessment test role.\n');
  } finally {
    await db.end();
  }
}

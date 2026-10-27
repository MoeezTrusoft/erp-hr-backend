import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const {Client}=createRequire(import.meta.url)('pg');
const url=new URL(process.env.DATABASE_URL||'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/hr_recruitment_migration_test'||!process.argv.includes('--reset'))throw new Error('Use --reset with the disposable local recruitment migration database');
const db=new Client({connectionString:url.href});await db.connect();
await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='erp') THEN CREATE ROLE erp; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='hr_app') THEN CREATE ROLE hr_app; END IF; END $$; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");await db.end();
const result=spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{stdio:'inherit',windowsHide:true,env:process.env});process.exitCode=result.status??1;

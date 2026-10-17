import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const pg=createRequire(createRequire(import.meta.url).resolve('@prisma/adapter-pg'))('pg');
const url=process.env.ASSESSMENT_TEST_DATABASE_URL;
test('company payroll summaries enforce tenant isolation and approved immutability in PostgreSQL', {skip:!url}, async()=>{
  assert.equal(new URL(url).pathname,'/hr_task_assessment_test');
  const db=new pg.Client({connectionString:url});await db.connect();
  const tenant=randomUUID(),other=randomUUID(),id=randomUUID();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
    const run=await db.query(`INSERT INTO payroll_runs("tenantId","periodStart","periodEnd","countryCode","currencyCode","updated_at") VALUES($1,'2026-10-01','2026-10-31','PK','PKR',now()) RETURNING id`,[tenant]);
    await db.query(`INSERT INTO payroll_finance_summaries(id,"tenantId",month,"runId",revision,"requestId","inputHash",payload,reason,"preparedBy") VALUES($1,$2,'2026-10',$3,1,'fixture','hash','{}','Synthetic test','104')`,[id,tenant,run.rows[0].id]);
    assert.equal((await db.query('SELECT id FROM payroll_finance_summaries WHERE id=$1',[id])).rowCount,1);
    await db.query("SELECT set_config('app.tenant_id',$1,true)",[other]);
    assert.equal((await db.query('SELECT id FROM payroll_finance_summaries WHERE id=$1',[id])).rowCount,0);
    assert.equal((await db.query('UPDATE payroll_finance_summaries SET reason=$2 WHERE id=$1',[id,'cross tenant'])).rowCount,0);
    await db.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
    await db.query(`UPDATE payroll_finance_summaries SET status='APPROVED',"approvedBy"='105',"approvedAt"=now() WHERE id=$1`,[id]);
    await db.query('SAVEPOINT immutable_summary');
    await assert.rejects(db.query('UPDATE payroll_finance_summaries SET payload=$2 WHERE id=$1',[id,'{}']),/immutable/);
    await db.query('ROLLBACK TO SAVEPOINT immutable_summary');
    await assert.rejects(db.query('DELETE FROM payroll_finance_summaries WHERE id=$1',[id]),/immutable/);
  } finally {await db.query('ROLLBACK');await db.end();}
});

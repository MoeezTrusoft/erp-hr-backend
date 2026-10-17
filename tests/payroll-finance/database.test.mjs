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

test('approved payment evidence survives JSONB storage and unchanged payroll revisions', {skip:!url}, async()=>{
  assert.equal(new URL(url).hostname,'127.0.0.1');
  assert.equal(new URL(url).pathname,'/hr_task_assessment_test');
  process.env.DATABASE_URL=url;process.env.NODE_ENV='test';
  process.env.HR_C4_ENCRYPTION_KEY=Buffer.alloc(32,17).toString('base64');
  process.env.HR_C4_BLIND_INDEX_KEY=Buffer.alloc(32,19).toString('base64');
  const {default:prisma}=await import('../../src/lib/prisma.js');
  const {tenantTransaction}=await import('../../src/lib/rlsTenant.js');
  const {mcpCtx}=await import('../../src/lib/requestContext.js');
  const {createPayrollFinanceService}=await import('../../src/services/payrollFinance.service.js');
  const {PayrollFinancePrepareInput}=await import('@trusoft/contracts/payroll-finance');
  const tenantId=randomUUID(),ctx=userId=>({user:{tenantId,userId},correlationId:'jsonb-regression'});
  const as=(userId,fn)=>mcpCtx.run(ctx(userId),fn);
  try {
    const run=await as(104,()=>tenantTransaction(prisma,async tx=>{
      const people=[];
      for(const role of ['maker','checker'])people.push(await tx.employee.create({data:{tenant_id:tenantId,employee_code:'FIN-JSON-'+randomUUID(),employeeCategory:'EMPLOYEE',first_name:'Synthetic',last_name:role,employee_name:'Synthetic '+role,payroll_included:false,status:'Inactive',employement_status:'Inactive'}}));
      const run=await tx.payrollRun.create({data:{tenantId,periodStart:new Date('2026-10-01'),periodEnd:new Date('2026-10-31'),countryCode:'PK',currencyCode:'PKR',status:'FINALIZED',totalGross:'100',totalDeductions:'0',totalNet:'100',employeeCount:1,processedBy:people[0].id,approvedBy:people[1].id,approvedAt:new Date()}});
      await tx.payrollPayslip.create({data:{tenantId,payrollRunId:run.id,employeeId:people[0].id,grossAmount:'100',totalDeductions:'0',netAmount:'100',status:'FINALIZED'}});
      return run;
    },{tenantId}));
    const service=createPayrollFinanceService(prisma);
    const payment={reference:'JSONB-PAY',date:'2026-10-31',amount:'30',accountRef:'BANK',evidenceAssetId:'synthetic-dam-evidence'};
    const input=(payments=[payment])=>PayrollFinancePrepareInput.parse({requestId:randomUUID(),runId:run.id,reason:'Synthetic database regression',payments});
    const firstInput=input();
    const first=await as(104,()=>service.prepare(ctx(104),firstInput));
    await as(105,()=>service.approve(ctx(105),{id:first.id,expectedVersion:1}));
    const stored=await as(104,()=>service.list(ctx(104),{month:'2026-10'}));
    assert.notEqual(JSON.stringify(stored.items[0].payload.payments[0]),JSON.stringify(payment));
    assert.deepEqual(stored.items[0].payload.payments[0],payment);
    assert.equal((await as(104,()=>service.prepare(ctx(104),firstInput))).id,first.id);
    const next=await as(104,()=>service.prepare(ctx(104),input()));
    assert.equal(next.revision,2);
    await as(105,()=>service.approve(ctx(105),{id:next.id,expectedVersion:1}));
    await assert.rejects(as(104,()=>service.prepare(ctx(104),input([{...payment,amount:'31'}]))),/retain previously approved/);
    await assert.rejects(as(104,()=>service.prepare(ctx(104),input([]))),/retain previously approved/);
  }finally{await prisma.$disconnect();}
});

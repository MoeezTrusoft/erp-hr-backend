import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPayrollFinanceService, payrollFinanceSource } from '../src/services/payrollFinance.service.js';
import { PayrollFinancePrepareInput } from '@trusoft/contracts/payroll-finance';
const tenantId='40314ef4-0a81-4390-b631-b3ad3f21f523';
const ctx=id=>({user:{tenantId,userId:id},correlationId:'finance-test'});
function fixture() {
  const summaries=[],events=[];
  const run={id:7,tenantId,status:'FINALIZED',periodStart:new Date('2026-10-01'),periodEnd:new Date('2026-10-31'),approvedBy:2,processedBy:1,currencyCode:'PKR',totalGross:'100.0000',totalDeductions:'10.0000',totalNet:'90.0000'};
  const slips=[{id:1,employeeId:8,status:'FINALIZED',grossAmount:'100.0000',totalDeductions:'10.0000',netAmount:'90.0000',deductions:[{amount:'10.0000',deductionType:{code:'TAX'}}]}];
  const matches=(v,w)=>Object.entries(w).every(([k,x])=>v[k]===x);
  const db={$executeRaw:async()=>1,payrollRun:{findFirst:async({where})=>where.tenantId===tenantId?run:null},payrollPayslip:{findMany:async()=>slips},
    payrollFinanceSummary:{findFirst:async({where,orderBy})=>[...summaries].sort((a,b)=>orderBy?b.revision-a.revision:0).find(v=>matches(v,where)),
      create:async({data})=>{const row={...data,status:'DRAFT',version:1};summaries.push(row);return row;},
      update:async({where,data})=>{const row=summaries.find(v=>matches(v,where));Object.assign(row,{...data,version:row.version+1});return row;},
      findMany:async({where})=>summaries.filter(v=>matches(v,where))},
    outboxEvent:{create:async({data})=>{events.push(data);return data;}},payrollAuditLog:{create:async()=>({})}};
  db.$transaction=async fn=>fn(db);
  return {db,run,slips,summaries,events,service:createPayrollFinanceService(db)};
}
const prepare=(over={})=>PayrollFinancePrepareInput.parse({requestId:randomUUID(),runId:7,reason:'Test company payroll',...over});
test('finalized source validates totals and never contains employee identities',async()=>{
  const {db,run,slips}=fixture(); const value=await payrollFinanceSource(db,tenantId,7);
  assert.equal(value.gross,'100.00'); assert(!JSON.stringify(value).includes('employeeId'));
  run.status='APPROVED'; await assert.rejects(payrollFinanceSource(db,tenantId,7),/finalized/);run.status='FINALIZED';
  run.totalNet='89'; await assert.rejects(payrollFinanceSource(db,tenantId,7),/totals differ/);run.totalNet='90';
  slips[0].grossAmount='100.001'; await assert.rejects(payrollFinanceSource(db,tenantId,7));
  await assert.rejects(payrollFinanceSource(db,randomUUID(),7),/not found/);
});
test('request retry, independent approval, source drift, durable outbox and cumulative payment revisions',async()=>{
  const {service,events,run}=fixture(), input=prepare();
  const first=await service.prepare(ctx(104),input); assert.equal((await service.prepare(ctx(104),input)).id,first.id);
  await assert.rejects(service.prepare(ctx(105),input),/actor/);
  await assert.rejects(service.approve(ctx(104),{id:first.id,expectedVersion:1}),/Independent/);
  run.totalGross='101';await assert.rejects(service.approve(ctx(105),{id:first.id,expectedVersion:1}),/totals differ/);run.totalGross='100';
  const approved=await service.approve(ctx(105),{id:first.id,expectedVersion:1});assert.equal(approved.status,'APPROVED');assert.equal(events.length,1);
  await service.approve(ctx(105),{id:first.id,expectedVersion:1});assert.equal(events.length,1);
  await service.republish(ctx(105),{id:first.id,expectedVersion:2});assert.equal(events.length,2);
  const payment={reference:'PAY1',date:'2026-10-31',amount:'30',accountRef:'BANK',evidenceAssetId:'test-dam-id'};
  const second=await service.prepare(ctx(104),prepare({payments:[payment]}));assert.equal(second.revision,2);assert.equal(second.payload.paymentStatus,'PARTIAL');
  await service.approve(ctx(105),{id:second.id,expectedVersion:1});
  second.payload.payments[0]=Object.fromEntries(Object.entries(payment).reverse());
  await assert.rejects(service.prepare(ctx(104),prepare()),/retain/);
  await assert.rejects(service.prepare(ctx(104),prepare({payments:[{...payment,amount:'100'}]})),/retain/);
  assert.throws(()=>prepare({employerContribution:'12'}),/evidence/);
  const third=await service.prepare(ctx(104),prepare({payments:[payment],employerContribution:'12',employerContributionEvidenceAssetId:'company-contribution-proof'}));
  await service.cancel(ctx(104),{id:third.id,expectedVersion:1,reason:'Correct source evidence'});
  await assert.rejects(service.approve(ctx(105),{id:third.id,expectedVersion:2}),/Draft/);
  await assert.rejects(service.prepare(ctx(104),prepare()),/retain/);
  const corrected=await service.prepare(ctx(104),prepare({payments:[payment],employerContribution:'12',employerContributionEvidenceAssetId:'company-contribution-proof-v2'}));
  const final=await service.approve(ctx(105),{id:corrected.id,expectedVersion:1});
  assert.equal(final.payload.employerContribution,'12');assert.equal(final.revision,4);
});

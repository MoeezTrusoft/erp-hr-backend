import {describe,it,expect} from '@jest/globals';
import {captureDb,TENANT} from '../helpers/captureDb.js';
import {reconcileRulePayroll,releaseFailedCarry,priceRuleDays} from '../../src/services/attendanceRulePayroll.service.js';
import {adoptHistoricalPricing} from '../../src/services/attendanceRules.service.js';
const date=new Date('2026-09-15');
const anomaly=(id,type='LATE_CHECKIN',extra={})=>({id,tenantId:TENANT,employeeId:1,date,sessionKey:'shift-'+id,type,measuredMinutes:45,rulesVersion:2,status:'REJECTED',decisionRole:'Management',evidenceState:'ACTIVE',...extra});
function fixture({paid=false,oldDays=1,cases=[],next=false,legacy=false}={}) {
 const run={id:1,tenantId:TENANT,periodStart:new Date('2026-09-01'),periodEnd:new Date('2026-09-30'),currencyCode:'PKR',status:'FINALIZED',totalDeductions:String(oldDays*1000),totalNet:String(30000-oldDays*1000)};
 const slip={id:1,tenantId:TENANT,payrollRunId:1,employeeId:1,status:paid?'DISTRIBUTED':'FINALIZED',distributedAt:paid?date:null,attendanceBasisMinor:legacy?null:'3000000',attendancePeriodDays:legacy?null:30,grossAmount:'30000',totalDeductions:run.totalDeductions,netAmount:run.totalNet,payableDays:30-oldDays};
 return captureDb({employee:[{id:1,tenant_id:TENANT}],payrollRun:[run,...(next?[{...run,id:2,periodStart:new Date('2026-10-01'),periodEnd:new Date('2026-10-31'),totalDeductions:'0',totalNet:'30000'}]:[])],payrollPayslip:[slip,...(next?[{...slip,id:2,payrollRunId:2,status:'FINALIZED',distributedAt:null,totalDeductions:'0',netAmount:'30000',payableDays:31}]:[])],payrollDeductionType:[{id:1,tenantId:TENANT,code:legacy?'ABSENCE_RECOVERY':'ATTENDANCE_RULES_V2'}],payrollDeduction:[{id:1,tenantId:TENANT,payslipId:1,deductionTypeId:1,amount:String(oldDays*1000),description:`Attendance ${oldDays} day(s)`}],attendanceAnomaly:cases});
}
const reconcile=db=>db.$transaction(tx=>reconcileRulePayroll(tx,{tenantId:TENANT,employeeId:1,date}));
describe('attendance financial revisions',()=>{
 it('recalculates finalized unpaid payroll and day quantities, once',async()=>{
  const db=fixture({cases:[anomaly(1)]});await reconcile(db);await reconcile(db);
  expect(db.snapshot().payrollPayslip[0]).toMatchObject({totalDeductions:'500.0000',netAmount:'29500.0000',payableDays:29.5,status:'FINALIZED'});
  expect(db.snapshot().payrollRun[0].totalNet).toBe('29500.0000');
  expect(db.snapshot().payrollAuditLog).toHaveLength(1);
 });
 it('keeps paid payroll untouched and appends signed, idempotent refunds and recoveries',async()=>{
  const db=fixture({paid:true});const before=db.snapshot().payrollPayslip[0];await reconcile(db);await reconcile(db);
  expect(db.snapshot().payrollPayslip[0]).toEqual(before);
  expect(db.snapshot().attendancePayrollAdjustment.map(a=>a.amountMinor)).toEqual(['-100000']);
  await db.attendanceAnomaly.create({data:anomaly(1)});await reconcile(db);await reconcile(db);
  expect(db.snapshot().attendancePayrollAdjustment.map(a=>a.amountMinor)).toEqual(['-100000','50000']);
 });
 it('refunds a collapsed group of three minors across the actual payroll period',async()=>{
  const db=fixture({paid:true,cases:[anomaly(1,'LATE_CHECKIN',{measuredMinutes:10}),anomaly(2,'EARLY_CHECKOUT',{measuredMinutes:20}),anomaly(3,'LATE_CHECKIN',{measuredMinutes:30})]});
  await reconcile(db);expect(db.snapshot().attendancePayrollAdjustment).toHaveLength(0);
  await db.attendanceAnomaly.update({where:{id:2},data:{status:'RESOLVED',evidenceState:'RESOLVED'}});await reconcile(db);
  expect(db.snapshot().attendancePayrollAdjustment[0].amountMinor).toBe('-100000');
 });
 it('updates an already finalized but unpaid next payroll, without changing its current-period days',async()=>{
  const db=fixture({paid:true,next:true});await reconcile(db);await reconcile(db);
  expect(db.snapshot().payrollPayslip[1]).toMatchObject({netAmount:'31000.0000',totalDeductions:'-1000.0000',payableDays:31,status:'FINALIZED'});
  expect(db.snapshot().attendancePayrollAdjustment[0].appliedPayslipId).toBe(2);
  expect(db.snapshot().payrollDeduction.filter(d=>d.payslipId===2)).toHaveLength(1);
 });
 it('rolls the whole change back if the target payroll is processing',async()=>{
  const db=fixture({paid:true,next:true});await db.payrollRun.update({where:{id:2},data:{status:'PROCESSING'}});
  await expect(reconcile(db)).rejects.toThrow('next payroll is processing');
  expect(db.snapshot().attendancePayrollAdjustment).toHaveLength(0);
 });
 it('requires documented historical pricing and Management adoption instead of guessing current salary',async()=>{
  const db=fixture({paid:true,legacy:true});await expect(reconcile(db)).rejects.toThrow('historical payslip');
  const user={tenantId:TENANT,userId:'m1',roles:['Management']};
  await expect(adoptHistoricalPricing({user:{...user,roles:['HR']},payslipId:1,basis:'30000',reason:'Archived contract'},db)).rejects.toThrow('Management');
  await adoptHistoricalPricing({user,payslipId:1,basis:'30000',reason:'Archived September salary contract'},db);
  await reconcile(db);expect(db.snapshot().attendancePayrollAdjustment[0].amountMinor).toBe('-100000');
  await expect(adoptHistoricalPricing({user,payslipId:1,basis:'45000',reason:'Replace'},db)).rejects.toThrow('already has');
 });
 it('releases adjustments from failed unpaid target runs for a later run to claim',async()=>{
  const db=fixture({paid:true,next:true});await reconcile(db);
  await db.payrollRun.update({where:{id:2},data:{status:'FAILED'}});
  await db.$transaction(tx=>releaseFailedCarry(tx,{tenantId:TENANT,employeeId:1}));
  expect(db.snapshot().attendancePayrollAdjustment[0].appliedPayslipId).toBeNull();
  expect(db.snapshot().attendanceRuleAudit.at(-1).action).toBe('CARRY_RELEASED_FROM_FAILED_RUN');
 });
 it('changes day quantities even when a zero salary produces no monetary delta',async()=>{
  const db=fixture({oldDays:0,cases:[anomaly(1)]});await db.payrollPayslip.update({where:{id:1},data:{attendanceBasisMinor:'0'}});
  await reconcile(db);expect(db.snapshot().payrollPayslip[0].payableDays).toBe(29.5);
 });
 it('prices exact half days without floating point money and rejects invalid divisors',()=>{
  expect(priceRuleDays(.5,'3100000',31,'PKR')).toBe(50000n);
  expect(()=>priceRuleDays(.5,'1000',0)).toThrow('Invalid');
 });
});

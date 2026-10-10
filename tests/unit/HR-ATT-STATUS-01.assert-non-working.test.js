// Behavioural regression against published configuration and the real interval writer.
import {describe,it,expect} from '@jest/globals';
import {evaluationDb,evaluate,TENANT,DATE,day,fixed,rotation} from '../helpers/evaluationDb.js';
describe('explicit non-working attendance',()=>{
 it.each(['OFF','ROTATION','HOLIDAY','LEAVE'])('records %s without a payroll hold',async kind=>{
  const db=evaluationDb({pattern:kind==='ROTATION'?rotation:kind==='OFF'?{...fixed,offDays:[7]}:fixed,
    configure:c=>{if(kind==='HOLIDAY')c.holidays=[{holidayCalendarId:1,date:DATE,name:'Holiday',fullDay:true}];},
    extra:kind==='LEAVE'?{leave:[{tenantId:TENANT,employeeId:1,status:'APPROVED',start_date:day(),end_date:day()}]}:{}});
  await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({status:kind==='HOLIDAY'?'HOLIDAY':kind==='LEAVE'?'ON_LEAVE':'WEEKLY_OFF',day_credit:0,requires_regularization:false,processingState:'FINALIZED'});
 });
 it('restates stale off-day rows without deleting their identity',async()=>{
  const db=evaluationDb({pattern:{...fixed,offDays:[7]},rows:[{id:8,status:'ABSENT'}]});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({id:8,status:'WEEKLY_OFF'});
  expect(db.snapshot().attendanceEvaluation).toHaveLength(1);
 });
 it('preserves corrected days',async()=>{
  const db=evaluationDb({pattern:{...fixed,offDays:[7]},rows:[{status:'ABSENT',manually_corrected:true}]});await evaluate(db);
  expect(db.snapshot().attendance[0].status).toBe('ABSENT');
 });
 it('counts real work on a rest day',async()=>{
  const db=evaluationDb({pattern:{...fixed,offDays:[7]},punches:[['09:00',0],['17:00',1]]});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({status:'PRESENT',total_hours:8});
 });
 it('batch-loads source data for a month and produces one revision per date',async()=>{
  const db=evaluationDb({pattern:{...fixed,offDays:[1,2,3,4,5,6]}});
  await evaluate(db,{from:'2026-08-01',to:'2026-08-31'});
  expect(db.snapshot().attendance).toHaveLength(31);
  expect(db.calls.filter(c=>c.method==='findMany').length).toBeLessThan(50);
  expect(db.calls.filter(c=>c.model==='employee'&&c.method==='findMany')).toHaveLength(2);
 });
 it('does not write a preview',async()=>{
  const db=evaluationDb({pattern:{...fixed,offDays:[7]}});expect((await evaluate(db,{dryRun:true})).nonWorking).toBe(1);
  expect(db.snapshot().attendance).toHaveLength(0);
 });
});

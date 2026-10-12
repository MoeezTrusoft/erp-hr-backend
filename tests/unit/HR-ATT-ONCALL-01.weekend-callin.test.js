// Behavioural regression against published configuration and the real interval writer.
import {describe,it,expect} from '@jest/globals';
import {evaluationDb,evaluate,TENANT,DATE,day,fixed,rotation} from '../helpers/evaluationDb.js';
import {resolveWorkingDays} from '../../src/services/workingDay.service.js';
const off={...fixed,offDays:[7]};
const call={tenantId:TENANT,employeeId:1,date:day(),reason:'Weekend cover'};
const resolve=async db=>(await resolveWorkingDays({tenantId:TENANT,employeeId:1,from:DATE,to:DATE,db})).get(DATE);
describe('published on-call and roster correction rules',()=>{
 it('keeps Sunday off without a call-in',async()=>{
  expect(await resolve(evaluationDb({pattern:off}))).toMatchObject({working:false,reason:'OFF_DAY'});
 });
 it.each([off,rotation])('a dated call-in overrides rest',async pattern=>{
  expect(await resolve(evaluationDb({pattern,extra:{attendanceCallIn:[call]}}))).toMatchObject({working:true,reason:'ON_CALL'});
 });
 it('approved leave outranks a call-in',async()=>{
  const db=evaluationDb({pattern:off,extra:{attendanceCallIn:[call],leave:[{tenantId:TENANT,employeeId:1,status:'APPROVED',start_date:day(),end_date:day()}]}});
  expect(await resolve(db)).toMatchObject({working:false,reason:'APPROVED_LEAVE'});
 });
 it('restates a stale weekly-off row when the called-in employee is a no-show',async()=>{
  const db=evaluationDb({pattern:off,rows:[{status:'WEEKLY_OFF'}],extra:{attendanceCallIn:[call]}});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({id:5,status:'ABSENT',day_credit:0,processingState:'FINALIZED'});
 });
 it('uses real work evidence on the called-in date',async()=>{
  const db=evaluationDb({pattern:off,punches:[['09:00',0],['17:00',1]],extra:{attendanceCallIn:[call]}});await evaluate(db);
  expect(db.snapshot().attendance[0].status).toBe('PRESENT');
 });
 it('does not charge a Sunday with no call-in',async()=>{
  const db=evaluationDb({pattern:off});await evaluate(db);expect(db.snapshot().attendance[0].status).toBe('WEEKLY_OFF');
 });
 it('reconciles a stale rest day after a published roster change',async()=>{
  const db=evaluationDb({rows:[{status:'WEEKLY_OFF'}]});await evaluate(db);
  expect(db.snapshot().attendance[0].status).toBe('ABSENT');
 });
 it('keeps a rest-day row under the unchanged roster',async()=>{
  const db=evaluationDb({pattern:off});await evaluate(db);await evaluate(db);
  expect(db.snapshot().attendanceEvaluation).toHaveLength(1);
 });
});

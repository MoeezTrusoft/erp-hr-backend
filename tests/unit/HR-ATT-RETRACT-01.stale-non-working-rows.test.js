// Behavioural regression against published configuration and the real interval writer.
import {describe,it,expect} from '@jest/globals';
import {evaluationDb,evaluate,TENANT,DATE,day,fixed,rotation} from '../helpers/evaluationDb.js';
describe('reconciliation of stale automatic rows',()=>{
 it.each(['ABSENT','MISSING_CHECKOUT'])('restates stale %s on a rotation rest day',async status=>{
  const db=evaluationDb({pattern:rotation,rows:[{status}]});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({id:5,status:'WEEKLY_OFF',day_credit:0});
 });
 it('retains a real no-show on a working day',async()=>{
  const db=evaluationDb({rows:[{status:'ABSENT'}]});await evaluate(db);
  expect(db.snapshot().attendance[0].status).toBe('ABSENT');
 });
 it('never retracts a manually corrected row',async()=>{
  const db=evaluationDb({pattern:rotation,rows:[{status:'ABSENT',manually_corrected:true}]});await evaluate(db);
  expect(db.snapshot().attendance[0].status).toBe('ABSENT');
 });
 it('keeps actual worked intervals on a weekly off day',async()=>{
  const db=evaluationDb({pattern:{...fixed,offDays:[7]},punches:[['09:00',0],['17:00',1]]});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({status:'PRESENT',total_hours:8});
 });
 it('previews a restatement without mutating the row',async()=>{
  const db=evaluationDb({pattern:rotation,rows:[{status:'ABSENT'}]});const result=await evaluate(db,{dryRun:true});
  expect(result.changes[0].after.status).toBe('WEEKLY_OFF');expect(db.snapshot().attendance[0].status).toBe('ABSENT');
 });
});

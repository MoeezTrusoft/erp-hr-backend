// Behavioural regression against published configuration and the real interval writer.
import {describe,it,expect} from '@jest/globals';
import {evaluationDb,evaluate,TENANT,DATE,day,fixed,rotation} from '../helpers/evaluationDb.js';
describe('ambiguous legacy rotation',()=>{
 const ambiguous={rotatingShifts:rotation.rotatingShifts,offDays:[]};
 it('holds a no-punch date until a rotation assignment is known',async()=>{
  const db=evaluationDb({pattern:ambiguous});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({status:'SETUP_REQUIRED',day_credit:null});
 });
 it('still evaluates fixed roster no-shows',async()=>{
  const db=evaluationDb();await evaluate(db);expect(db.snapshot().attendance[0].status).toBe('ABSENT');
 });
 it('surfaces the uncertain date in the preview',async()=>{
  const result=await evaluate(evaluationDb({pattern:ambiguous}),{dryRun:true});
  expect(result.held).toBe(1);expect(result.byStatus.SETUP_REQUIRED).toBe(1);
 });
 it('evaluates actual punches against their rotation window',async()=>{
  const db=evaluationDb({pattern:ambiguous,punches:[['09:00',0],['17:00',1]]});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({status:'PRESENT',total_hours:8});
 });
});

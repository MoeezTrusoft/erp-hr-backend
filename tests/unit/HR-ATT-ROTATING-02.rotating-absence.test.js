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
// A 3-day day, night, off cycle states the phase (offIndex) even without an explicit shift
// sequence, so publishing accepts it without per-day assignments. Evaluation has to agree:
// otherwise a roster HR can publish produces days that can never be graded, and no rules-v2
// case (hence no resolution request) can ever exist for a no-show on it.
describe('phased day, night, off rotation',()=>{
 const phased={rotatingShifts:rotation.rotatingShifts,offDays:[],cycle:{days:3,anchor:'2026-08-01',offIndex:2}};
 it('charges a no-show on a working day instead of holding the day',async()=>{
  const db=evaluationDb({pattern:phased});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({status:'ABSENT',day_credit:null});
 });
 it('opens a rules-v2 case the employee or HR can raise',async()=>{
  const db=evaluationDb({pattern:phased});await evaluate(db);
  const cases=db.snapshot().attendanceAnomaly;
  expect(cases).toHaveLength(1);
  expect(cases[0]).toMatchObject({type:'ABSENT',status:'PENDING',rulesVersion:2});
  expect(cases[0].raisedById ?? null).toBeNull();
 });
 it('rests the cycle position that is the off day',async()=>{
  const db=evaluationDb({pattern:phased});await evaluate(db,{from:'2026-08-03',to:'2026-08-03'});
  expect(db.snapshot().attendance[0]).toMatchObject({status:'WEEKLY_OFF',day_credit:0});
 });
});

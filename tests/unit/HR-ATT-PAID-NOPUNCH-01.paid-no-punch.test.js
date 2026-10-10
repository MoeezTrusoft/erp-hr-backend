// Behavioural regression against published configuration and the real interval writer.
import {describe,it,expect} from '@jest/globals';
import {evaluationDb,evaluate,TENANT,DATE,day,fixed,rotation} from '../helpers/evaluationDb.js';
describe('paid-without-punches published profile',()=>{
 it.each([false,true])('credits a paid day with stale absence = %s',async stale=>{
  const db=evaluationDb({pattern:{...fixed,paidWithoutPunches:true},rows:stale?[{status:'ABSENT'}]:[]});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({status:'PRESENT',day_credit:1,processingState:'FINALIZED'});
 });
 it('still marks a regular no-show absent',async()=>{
  const db=evaluationDb();await evaluate(db);expect(db.snapshot().attendance[0].status).toBe('ABSENT');
 });
 it('does not override a manual decision',async()=>{
  const db=evaluationDb({pattern:{...fixed,paidWithoutPunches:true},rows:[{status:'ABSENT',manually_corrected:true}]});await evaluate(db);
  expect(db.snapshot().attendance[0].status).toBe('ABSENT');
 });
});

// Behavioural regression against published configuration and the real interval writer.
import {describe,it,expect} from '@jest/globals';
import {evaluationDb,evaluate,TENANT,DATE,day,fixed,rotation} from '../helpers/evaluationDb.js';
describe('off-day evidence is retained without manufacturing absence',()=>{
 it.each([{...fixed,offDays:[7]},rotation])('records an off day for a lone scan',async pattern=>{
  const db=evaluationDb({pattern,punches:[['09:00',0]]});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({status:'WEEKLY_OFF',day_credit:0});
 });
 it('keeps a complete pair on a rest day',async()=>{
  const db=evaluationDb({pattern:{...fixed,offDays:[7]},punches:[['09:00',0],['17:00',1]]});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({status:'PRESENT',total_hours:8});
 });
 it('retains the missing-checkout hold on a working day',async()=>{
  const db=evaluationDb({punches:[['09:00',0]]});await evaluate(db);
  expect(db.snapshot().attendance[0]).toMatchObject({status:'MISSING_CHECKOUT',day_credit:null});
 });
 it('holds an unpublished employee date',async()=>{
  const db=evaluationDb({configure:c=>{c.employees=[];},punches:[['09:00',0]]});await evaluate(db);
  expect(db.snapshot().attendance[0].status).toBe('SETUP_REQUIRED');
 });
 it('does not delete original scan evidence',async()=>{
  const db=evaluationDb({pattern:{...fixed,offDays:[7]},punches:[['09:00',0]]});await evaluate(db);
  expect(db.snapshot().attendanceDevicePunch).toHaveLength(1);
 });
});

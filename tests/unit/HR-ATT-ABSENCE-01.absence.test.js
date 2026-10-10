// Behavioural regression against published configuration and the real interval writer.
import {describe,it,expect} from '@jest/globals';
import {evaluationDb,evaluate,TENANT,DATE,day,fixed,rotation} from '../helpers/evaluationDb.js';
import {markAbsences} from '../../src/services/absenceMarking.service.js';
const mark=(db,opts={})=>markAbsences({tenantId:TENANT,from:DATE,to:DATE,now:new Date('2026-08-05'),db,...opts});
describe('absence guards through the published evaluator',()=>{
 it('holds employees without published setup rather than charging absence',async()=>{
  const db=evaluationDb({configure:c=>{c.employees=[];}});await mark(db,{dryRun:false});
  expect(db.snapshot().attendance[0]).toMatchObject({status:'SETUP_REQUIRED',day_credit:null});
 });
 it('records an off day without an absence deduction',async()=>{
  const db=evaluationDb({pattern:{...fixed,offDays:[7]}});expect((await mark(db)).marked).toBe(0);
 });
 it('uses actual punch evidence rather than overwriting attendance with absence',async()=>{
  const db=evaluationDb({punches:[['09:00',0],['17:00',1]]});await mark(db,{dryRun:false});
  expect(db.snapshot().attendance[0].status).toBe('PRESENT');
 });
 it('preserves a human correction',async()=>{
  const db=evaluationDb({rows:[{status:'PRESENT',day_credit:1,manually_corrected:true}]});
  expect((await mark(db,{dryRun:false})).manuallyCorrected).toBe(1);
  expect(db.snapshot().attendance[0].status).toBe('PRESENT');
 });
 it('defaults to preview and writes no attendance or jobs',async()=>{
  const db=evaluationDb();expect((await mark(db)).marked).toBe(1);
  expect(db.snapshot().attendance).toHaveLength(0);expect(db.snapshot().attendanceEvaluationJob).toHaveLength(0);
 });
 it('finalizes evidenced no-shows after their own deadline under the published deduction policy',async()=>{
  const db=evaluationDb();await mark(db,{dryRun:false});
  expect(db.snapshot().attendance[0]).toMatchObject({status:'ABSENT',day_credit:0,processingState:'FINALIZED',requires_regularization:false});
 });
 it('rejects reversed ranges',async()=>{
  await expect(mark(evaluationDb(),{from:'2026-08-03'})).rejects.toThrow();
 });
});

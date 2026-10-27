// The attachment replaces grand-total flooring and arbitrary legacy rule counters.
import {describe,it,expect} from '@jest/globals';
import {buildPayslipFromInputs} from '../../src/services/payrollService.js';
const run={periodStart:new Date('2026-08-01'),periodEnd:new Date('2026-08-31'),currencyCode:'PKR',countryCode:'PK'};
const decided=(id,type,minutes=20)=>({id,employeeId:1,date:`2026-08-${String(id).padStart(2,'0')}`,sessionKey:'s'+id,type,measuredMinutes:minutes,rulesVersion:2,status:'REJECTED',decisionRole:'Management',evidenceState:'ACTIVE'});
const build=(cases,config={})=>buildPayslipFromInputs({employee:{id:1},employmentTerm:{baseSalary:31000,currency:'PKR',payFrequency:'MONTHLY'},payrollRun:run,bridges:{anomalyRows:cases,attendanceDeductionLines:[{days:10,ruleKey:'LATE'}]},ruleConfig:config});
const amount=slip=>Number(slip.deductions.find(d=>d.code==='ATTENDANCE_RULES_V2')?.amount||0);
describe('fixed attachment rules replace legacy pooled-floor modes',()=>{
 it.each(['GROSS','POOLED_FLOOR','POOLED_FLOOR_DIRECT'])('pools only disapproved minor lateness/early departure in %s mode',deductionBasis=>{
  expect(amount(build([decided(1,'LATE_CHECKIN'),decided(2,'EARLY_CHECKOUT'),decided(3,'LATE_CHECKIN')],{deductionBasis}))).toBe(1000);
 });
 it('prices three missing punches at half a day each and never pools them as minor timing',()=>{
  expect(amount(build([1,2,3].map(id=>decided(id,'MISSING_CHECKOUT')),{deductionBasis:'POOLED_FLOOR_DIRECT'}))).toBe(1500);
 });
 it('keeps a major half-day even with an incomplete minor group',()=>{
  expect(amount(build([decided(1,'LATE_CHECKIN',45),decided(2,'EARLY_CHECKOUT',20)],{deductionBasis:'POOLED_FLOOR'}))).toBe(500);
 });
 it('does not price pending, approved, or legacy arbitrary lines',()=>{
  expect(amount(build([{...decided(1,'ABSENT'),status:'PENDING'},{...decided(2,'LATE_CHECKIN'),status:'APPROVED'}]))).toBe(0);
 });
 it('ignores the obsolete absence recovery switch for a Management disapproval',()=>{
  expect(amount(build([decided(1,'ABSENT')],{absenceRecoveryEnabled:false}))).toBe(1000);
 });
});

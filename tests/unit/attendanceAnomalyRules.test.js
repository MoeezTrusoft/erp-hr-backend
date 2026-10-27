import {describe,it,expect} from '@jest/globals';
import {resolveGrace,anomalyFacts,ruleDeductions,isManagement} from '../../src/lib/attendanceAnomalyRules.js';
import {evaluateShift} from '../../src/lib/attendanceEvaluator.js';
import {buildPayslipFromInputs} from '../../src/services/payrollService.js';
const at=time=>new Date('2026-10-01T'+time+':00Z');
const shift={start:at('09:00'),end:at('17:00')};
const score=(times,policy={})=>evaluateShift({shift,now:new Date('2026-10-02'),policy,punches:times.map(([time,type])=>({timestamp:at(time),type,directionVerified:true}))});
const rejected=(id,type,minutes=10,extra={})=>({id,type,date:'2026-10-01',employeeId:1,sessionKey:'09:00',rulesVersion:2,status:'REJECTED',evidenceState:'ACTIVE',decisionRole:'Management',measuredMinutes:minutes,...extra});
describe('attached attendance rules',()=>{
 it('resolves each grace independently, including explicit zero and dated inheritance',()=>{
  const rules=[{scope:'COMPANY',scopeKey:'*',effectiveFrom:'2026-01-01',checkInMinutes:5,checkOutMinutes:7},
   {scope:'TEAM',scopeKey:'A',effectiveFrom:'2026-01-01',checkInMinutes:10},
   {scope:'EMPLOYEE',scopeKey:'1',effectiveFrom:'2026-10-02',checkInMinutes:0},
   {scope:'SHIFT',scopeKey:'D',effectiveFrom:'2026-01-01',checkOutMinutes:3}];
  expect(resolveGrace(rules,{employeeId:1,teamKey:'A',shiftKey:'D',date:'2026-10-01'})).toMatchObject({checkInMinutes:10,checkOutMinutes:3});
  expect(resolveGrace(rules,{employeeId:1,teamKey:'A',shiftKey:'D',date:'2026-10-02'})).toMatchObject({checkInMinutes:0,checkOutMinutes:3});
  expect(resolveGrace([],{employeeId:1,date:'2026-10-02'})).toMatchObject({checkInMinutes:0,checkOutMinutes:0});
 });
 it.each([[[],['ABSENT']],[[['09:20','IN']],['MISSING_CHECKOUT','LATE_CHECKIN']],[[['16:40','OUT']],['MISSING_CHECKIN','EARLY_CHECKOUT']],[[['10:00','IN'],['16:00','OUT']],['LATE_CHECKIN','EARLY_CHECKOUT']]])('detects independent anomalies for %j',(times,types)=>{
  const result=score(times);expect(result.anomalies.map(a=>a.type)).toEqual(types);expect(result.dayCredit).toBeNull();
 });
 it('uses strict grace and severity boundaries without subtracting grace from severity',()=>{
  expect(anomalyFacts({checkIn:at('09:30'),checkOut:at('17:00'),shift,grace:{checkInMinutes:30}})).toEqual([]);
  const facts=anomalyFacts({checkIn:new Date(+at('09:30')+1000),checkOut:at('17:00'),shift,grace:{checkInMinutes:30}});
  expect(facts[0].severity).toBe('MAJOR');expect(facts[0].minutes).toBeGreaterThan(30);
 });
 it('does not wrap a long overnight late arrival backwards across twelve hours',()=>{
  const facts=anomalyFacts({checkIn:new Date('2026-10-02T11:00Z'),checkOut:new Date('2026-10-02T12:00Z'),shift:{start:new Date('2026-10-01T22:00Z'),end:new Date('2026-10-02T12:00Z')}});
  expect(facts[0].minutes).toBe(780);
 });
 it('prices two major anomalies independently and counts multiple shifts',()=>{
  expect(ruleDeductions([rejected(1,'LATE_CHECKIN',31),rejected(2,'EARLY_CHECKOUT',31)]).days).toBe(1);
  expect(ruleDeductions([rejected(1,'ABSENT'),rejected(2,'ABSENT',0,{sessionKey:'18:00'})]).days).toBe(2);
 });
 it('combines seven minor late/early cases into two days and drops the remainder',()=>{
  const result=ruleDeductions(Array.from({length:7},(_,i)=>rejected(i+1,i%2?'LATE_CHECKIN':'EARLY_CHECKOUT',30,{sessionKey:String(i)})));
  expect(result).toMatchObject({days:2,minorCount:7,minorRemainder:1});
 });
 it('never pools across employees or periods and never prices unresolved, approved or reversed cases',()=>{
  const cases=[rejected(1,'LATE_CHECKIN',10),rejected(2,'EARLY_CHECKOUT',10),rejected(3,'EARLY_CHECKOUT',10,{employeeId:2}),
   rejected(4,'LATE_CHECKIN',10,{date:'2026-11-01'}),rejected(5,'ABSENT',0,{status:'PENDING'}),rejected(6,'ABSENT',0,{status:'APPROVED'}),rejected(7,'ABSENT',0,{evidenceState:'RESOLVED'})];
  expect(ruleDeductions(cases,{from:'2026-10-01',to:'2026-10-31'}).days).toBe(0);
 });
 it('does not accept admin or similarly named roles as Management',()=>{
  expect(isManagement({isAdmin:true,roles:['HR','Line Management']})).toBe(false);
  expect(isManagement({roles:[{name:'Management'}]})).toBe(true);
 });
 it('cannot excuse another anomaly by approving one on the same shift',()=>{
  expect(ruleDeductions([rejected(1,'LATE_CHECKIN',45,{status:'APPROVED'}),rejected(2,'EARLY_CHECKOUT',45)]).days).toBe(.5);
 });
 it('new payroll does not charge undecided automatic attendance or legacy manual markings',()=>{
  const result=buildPayslipFromInputs({employee:{id:1},employmentTerm:{baseSalary:'31000',currency:'PKR'},assignments:[],payrollRun:{periodStart:new Date('2026-10-01'),periodEnd:new Date('2026-10-31'),currencyCode:'PKR',countryCode:'PK'},taxRateRows:[],ruleConfig:{absenceRecoveryEnabled:true},bridges:{attendanceRows:[{date:'2026-10-01',status:'ABSENT',day_credit:0}],anomalyRows:[rejected(1,'ABSENT',0,{status:'PENDING',manualDeductionDays:1})]}});
  expect(result.deductions.find(d=>d.code==='ATTENDANCE_RULES_V2')).toBeUndefined();
  expect(result.deductions.some(d=>['ABSENCE_RECOVERY','MANAGEMENT_ATTENDANCE_DEDUCTION'].includes(d.code))).toBe(false);
 });
});

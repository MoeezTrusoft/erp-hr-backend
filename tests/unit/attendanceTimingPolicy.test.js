import {describe,it,expect} from '@jest/globals';
import {countViolationDays,computeAttendanceDeductions} from '../../src/lib/attendanceDeduction.js';
import {normalizeTimingCredits} from '../../src/lib/attendanceTimingPolicy.js';
import {buildPayslipFromInputs} from '../../src/services/payrollService.js';
const rules=['LATE','EARLY_CHECKOUT'].map(ruleKey=>({ruleKey,enabled:true,triggerCount:3,deductionDays:1,counterGroup:'LATE_EARLY',durationThresholdMinutes:30,overThresholdDeductionDays:0.5,maxDeductionDaysPerPeriod:null}));
const row=(n,lateMinutes=0,earlyMinutes=0)=>({date:`2026-09-${String(n).padStart(2,'0')}T00:00:00Z`,status:lateMinutes&&earlyMinutes?'HALF_DAY':lateMinutes?'LATE':earlyMinutes?'EARLY_CHECKOUT':'PRESENT',day_credit:lateMinutes||earlyMinutes?0.5:1,lateMinutes,earlyMinutes});
const lines=(attendance,anomalies=[])=>computeAttendanceDeductions({violations:countViolationDays({attendance,anomalies,rules}),rules});
const days=(a,b)=>lines(a,b).reduce((n,l)=>n+l.days,0);
const build=(attendance,anomalies=[],activeRules=rules)=>buildPayslipFromInputs({employee:{id:1,hire_date:'2020-01-01'},employmentTerm:{baseSalary:'60000',payFrequency:'MONTHLY',currency:'PKR'},payrollRun:{periodStart:new Date('2026-09-01'),periodEnd:new Date('2026-09-30T23:59:59.999Z'),currencyCode:'PKR',countryCode:'PK'},ruleConfig:{absenceRecoveryEnabled:true,deductionBasis:'GROSS'},bridges:{attendanceRows:attendance,anomalyRows:anomalies,attendanceDeductionRules:activeRules}});
describe('Thirty-minute combined attendance policy',()=>{
 it('charges every >30 minute incident, never adding it to the short counter',()=>expect(days([row(1,31),row(2,0,90),row(3,10),row(4,20)])).toBe(1));
 it('puts exactly 30 minutes in the short band',()=>expect(days([row(1,30),row(2,0,30),row(3,30)])).toBe(1));
 it('treats 30 minutes and one second as over 30',()=>expect(days([row(1,30+1/60)])).toBe(0.5));
 it('combines both incident types even in the same shift',()=>expect(days([row(1,10,20),row(2,0,15)])).toBe(1));
 it('does not charge incomplete sets and counts six as two days',()=>{expect(days([row(1,1),row(2,2)])).toBe(0);expect(days([1,2,3,4,5,6].map(n=>row(n,n)))).toBe(2);});
 it('excuses the whole approved shift regardless of incident type',()=>expect(days([row(1,40,40)],[{date:row(1).date,type:'LATE_CHECKIN',status:'APPROVED'}])).toBe(0));
 it('deduplicates repeated rows and ignores manually corrected days',()=>expect(days([row(1,40),row(1,40),{...row(2,50),manually_corrected:true}])).toBe(0.5));
 it('does not charge timing credit loss again as absence recovery',()=>{const p=build([row(1,40)]);expect(Number(p.totalDeductions)).toBe(1000);expect(p.payableDays).toBe(29.5);expect(p.deductions.some(d=>d.code==='ABSENCE_RECOVERY')).toBe(false);});
 it('still recovers a genuine unexcused absence',()=>{const p=build([{...row(1),status:'ABSENT',day_credit:0},row(2,40)]);expect(Number(p.totalDeductions)).toBe(3000);});
 it('uses the highest manual marking per shift in place of timing',()=>{const p=build([row(1,40,40)],[{id:1,date:row(1).date,manualDeductionDays:0.5},{id:2,date:row(1).date,manualDeductionDays:0.5}]);expect(Number(p.totalDeductions)).toBe(1000);});
 it('requires duration evidence rather than guessing from credit',()=>expect(()=>days([{date:row(1).date,status:'LATE',day_credit:0.5}])).toThrow('Timing evidence missing'));
 it('does not mutate stored attendance facts',()=>{const a=row(1,40);expect(normalizeTimingCredits([a],rules)[0].day_credit).toBe(1);expect(a.day_credit).toBe(0.5);});
});

describe('Approved shift precedence',()=>{
 it.each(['OTHER','MISSING_CHECKIN','MISSING_CHECKOUT','ABSENT','LATE_CHECKIN','EARLY_CHECKOUT'])('excludes all automatic deductions for an approved %s request',type=>{
   const a={date:row(1).date,type,status:'APPROVED'};
   expect(Number(build([{...row(1),status:'ABSENT',day_credit:0}],[a]).totalDeductions)).toBe(0);
   expect(days([row(1,49,80)],[a])).toBe(0);
   expect(days([{date:row(1).date,status:'LATE'}],[a])).toBe(0);
 });
 it('does not excuse a different date or an unapproved request',()=>{
   expect(days([row(1,49),row(2,49)],[{date:row(1).date,type:'OTHER',status:'APPROVED'}])).toBe(0.5);
   expect(days([row(1,49)],[{date:row(1).date,type:'OTHER',status:'PENDING'}])).toBe(0.5);
 });
 it('removes approved shifts from short-incident counters',()=>expect(days([row(1,10),row(2,10),row(3,10)],[{date:row(2).date,type:'OTHER',status:'APPROVED'}])).toBe(0));
 it('preserves explicit management markings on approved shifts',()=>expect(Number(build([row(1,49)],[{date:row(1).date,type:'OTHER',status:'APPROVED',manualDeductionDays:0.5}]).totalDeductions)).toBe(1000));
});

import {approvedLeaveCoverage} from '../../src/lib/approvedLeaveCoverage.js';
it('clips approved leave to payroll month and deduplicates current/legacy stores',()=>{
 const requests=[{employeeId:1,status:'APPROVED',startDate:'2026-08-30',endDate:'2026-09-02'},{employeeId:1,status:'APPROVED',start_date:'2026-09-01',end_date:'2026-09-02'},{employeeId:2,status:'REJECTED',startDate:'2026-09-01',endDate:'2026-09-30'}];
 const a=approvedLeaveCoverage(requests,'2026-09-01','2026-09-30');expect(a).toHaveLength(2);expect(a.every(x=>x.employeeId===1)).toBe(true);expect(days([row(1,49)],a)).toBe(0);
});
it('excludes future leave and does not mutate source records',()=>{
 const requests=[{employeeId:1,status:'APPROVED',startDate:'2026-10-01',endDate:'2026-10-02'}];const before=JSON.stringify(requests);expect(approvedLeaveCoverage(requests,'2026-09-01','2026-09-30')).toEqual([]);expect(JSON.stringify(requests)).toBe(before);
});

it('does not turn present days into additional short late incidents',()=>{
 const attendance=[row(4,12),row(5,8),row(29,9),...[3,12,26].map(n=>({...row(n,9),status:'PRESENT',day_credit:1}))];
 expect(days(attendance)).toBe(1);
});
it('prices an explicit early anomaly even when the stored status is present',()=>{
 expect(days([{...row(1,0,49),status:'PRESENT'}],[{date:row(1).date,type:'EARLY_CHECKOUT',status:'PENDING'}])).toBe(0.5);
});
it('recovers a rejected zero-credit absence only once, with or without manual shifts',()=>{
 const r=[...rules,{ruleKey:'DISAPPROVED_LEAVE',enabled:true,triggerCount:1,deductionDays:1}];
 const a=[{...row(11),status:'ABSENT',day_credit:0}];const anomalies=[{date:row(11).date,type:'ABSENT',status:'REJECTED'}];
 expect(countViolationDays({attendance:a,anomalies,rules:r,absenceRecoveryEnabled:true})).toEqual([]);
 expect(countViolationDays({attendance:a,anomalies,rules:r,absenceRecoveryEnabled:false})).toEqual([{ruleKey:'DISAPPROVED_LEAVE',day:'2026-09-11'}]);
});

it('Adnan regression: three recorded short late arrivals and one rejected absence cost two days',()=>{
 const r=[...rules,{ruleKey:'DISAPPROVED_LEAVE',enabled:true,triggerCount:1,deductionDays:1}];
 const attendance=[row(4,12),row(5,8),row(29,9),...[3,12,26].map(n=>({...row(n,9),status:'PRESENT',day_credit:1})),{...row(11),status:'ABSENT',day_credit:0}];
 const p=build(attendance,[{date:row(11).date,type:'ABSENT',status:'REJECTED'}],r);
 expect(Number(p.totalDeductions)).toBe(4000);expect(p.payableDays).toBe(28);
 expect(p.deductions.filter(d=>d.code==='ABSENCE_RECOVERY')).toHaveLength(1);
});

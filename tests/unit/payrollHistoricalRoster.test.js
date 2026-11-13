import {describe,it,expect} from '@jest/globals';
import {enrichPayrollTiming} from '../../src/services/payrollTiming.service.js';
import {shiftFor,sessioniseByRoster} from '../../src/lib/attendanceReplay.js';
const tenantId='test';
const schedules=[{id:136,employeeId:487,effective_start_date:'2026-09-11',effective_end_date:null,schedule_pattern:{shift:{from:'22:00',to:'07:00'}}},{id:85,employeeId:487,effective_start_date:'2026-08-01',effective_end_date:'2026-09-10',schedule_pattern:{shift:{from:'15:00',to:'00:00'}}}];
const db={attendanceSetupRelease:{findMany:async()=>[{version:1,effectiveFrom:'2026-08-01',coverageThrough:'2026-09-30',config:{version:1,settings:{defaultCalendarId:1},policy:{graceMinutes:0,earlyLeaveGraceMin:0},employees:[{id:487,hire_date:'2026-08-01'}],periods:[],schedules,calendars:[{id:1}],holidays:[],calendarAssignments:[]}}]},leave:{findMany:async()=>[]},leaveRequest:{findMany:async()=>[]},attendanceCallIn:{findMany:async()=>[]},workSchedule:{findMany:async()=>schedules},shiftAssignment:{findMany:async()=>[]},attendancePolicyConfig:{findUnique:async()=>({graceMinutes:0,earlyLeaveGraceMin:0})}};
describe('Historical payroll shift evidence',()=>{
 it('does not treat after-midnight departures as early under stale 7AM anomaly snapshots',async()=>{
  const attendance=[{date:'2026-09-07',check_in:'2026-09-07T14:50:27Z',check_out:'2026-09-08T02:34:53Z'},{date:'2026-09-08',check_in:'2026-09-08T15:02:07Z',check_out:'2026-09-09T01:32:40Z'}];
  const employee={id:487,attendance,attendanceAnomalies:attendance.map((r,i)=>({date:r.date,type:'EARLY_CHECKOUT',expectedTime:`2026-09-0${i+8}T07:00:00Z`,actualTime:r.check_out}))};
  await enrichPayrollTiming({tenantId,payrollRun:{periodStart:new Date('2026-09-01'),periodEnd:new Date('2026-09-30')},employees:[employee],db});
  expect(attendance.map(r=>r.earlyMinutes)).toEqual([0,0]);
 });
 it('uses the new shift only from its effective date and real punches over stale actual times',async()=>{
  const attendance=[{date:'2026-09-11',check_in:'2026-09-11T22:00:00Z',check_out:'2026-09-12T06:30:00Z'}];
  await enrichPayrollTiming({tenantId,payrollRun:{periodStart:new Date('2026-09-01'),periodEnd:new Date('2026-09-30')},employees:[{id:487,attendance,attendanceAnomalies:[{date:'2026-09-11',type:'EARLY_CHECKOUT',expectedTime:'2026-09-12T00:00:00Z',actualTime:'2026-09-12T03:00:00Z'}]}],db});
  expect(attendance[0].earlyMinutes).toBe(30);
 });
 it('honors an explicit dated shift assignment over the recurring roster',async()=>{
  const attendance=[{date:'2026-09-07',check_in:'2026-09-07T15:00:00Z',check_out:'2026-09-08T00:30:00Z'}];
  await enrichPayrollTiming({tenantId,payrollRun:{periodStart:new Date('2026-09-01'),periodEnd:new Date('2026-09-30')},employees:[{id:487,attendance}],db:{...db,shiftAssignment:{findMany:async()=>[{employeeId:487,date:'2026-09-07',fromTime:'15:00',toTime:'01:00'}]}}});
  expect(attendance[0].earlyMinutes).toBe(30);
 });
 it('sessionizes changing historical shifts without applying the final roster to earlier days',()=>{
  const pattern=day=>schedules.find(s=>new Date(s.effective_start_date)<=day&&(!s.effective_end_date||new Date(s.effective_end_date)>=day))?.schedule_pattern;
  const stamps=['2026-09-07T14:50:27Z','2026-09-08T02:34:53Z','2026-09-08T15:02:07Z','2026-09-09T01:32:40Z','2026-09-11T22:00:00Z','2026-09-12T07:30:00Z'];
  const sessions=sessioniseByRoster(stamps.map((d,i)=>({punchedAt:new Date(d),status:i%2})),pattern);
  expect(sessions).toHaveLength(3);
  expect(sessions.map(s=>s.punches.length)).toEqual([2,2,2]);
  expect(sessions.map(s=>shiftFor(pattern,s.day,s.punches[0].timestamp).end.toISOString())).toEqual(['2026-09-08T00:00:00.000Z','2026-09-09T00:00:00.000Z','2026-09-12T07:00:00.000Z']);
 });
});

import {describe,it,expect} from '@jest/globals';
import {captureDb,TENANT,OTHER_TENANT} from '../helpers/captureDb.js';
import {applyEvaluatedShifts} from '../../src/services/attendanceWriter.service.js';
import {applyMissingTime as enterRuleTime,commentRuleCase,finalizeRuleCase,saveGraceRule,listRuleCases} from '../../src/services/attendanceRules.service.js';
import {ruleDeductions} from '../../src/lib/attendanceAnomalyRules.js';
import {loadSource} from '../../src/services/approval/adapters.js';
const prove=async(db,row)=>{const source=await loadSource(db,{tenantId:TENANT},'ATTENDANCE',`${row.id}@${row.factHash}`);await db.hrApprovalRequest.create({data:{tenantId:TENANT,kind:'ATTENDANCE',sourceRef:`${row.id}@${row.factHash}`,stage:'REJECTED',sourceHash:source.digest}});};
const date='2026-10-01',at=t=>new Date(`${date}T${t}:00Z`);
const hr={tenantId:TENANT,userId:'hr-user',employeeId:2,roles:['HR']};
const management={tenantId:TENANT,userId:'management-user',employeeId:3,roles:['Management']};
function fixture(items=[],pattern={shift:{from:'09:00',to:'17:00'},offDays:[]}) {
 const db=captureDb({hrApprovalRequest:[],employee:[{id:1,tenant_id:TENANT,managerId:4,employee_code:'EMP-1',employee_name:'Employee One'}],attendanceSetupRelease:[{tenantId:TENANT,version:1,effectiveFrom:new Date(date),coverageThrough:new Date('2026-12-31'),config:{version:1,settings:{timeZone:'Asia/Karachi',defaultCalendarId:1,profiles:[],assignments:[]},policy:{checkoutLeniencyMin:240},employees:[{id:1,payroll_included:true,hire_date:'2026-01-01'}],periods:[],schedules:[{employeeId:1,effective_start_date:'2026-01-01',schedule_pattern:pattern}],calendars:[{id:1,year:2026}],holidays:[],calendarAssignments:[]}}],attendanceDevicePunch:items.map(([time,status],i)=>({id:i+1,employeeId:1,tenantId:TENANT,sn:'DEVICE-1',punchedAt:at(time),status,directionVerified:true}))});db.$queryRawUnsafe=async()=>[];return db;
}
const evaluate=db=>applyEvaluatedShifts({tenantId:TENANT,from:date,to:date,employeeIds:[1],db,dryRun:false,now:new Date('2026-10-03')});
const current=db=>db.snapshot().attendanceAnomaly.filter(a=>a.evidenceState==='ACTIVE');
describe('per-shift anomaly review',()=>{
 it('validates both missing times atomically and preserves seconds for the major threshold',async()=>{
  const db=fixture();await evaluate(db);
  await expect(enterRuleTime({user:hr,employeeId:1,date,checkIn:'15:00',checkOut:'14:00',version:1,reason:'Invalid sequence'},db)).rejects.toThrow('later than');
  expect(db.snapshot().attendanceManualTime).toHaveLength(0);
  await expect(enterRuleTime({user:hr,employeeId:1,date,checkIn:'25:00',version:1,reason:'Invalid time'},db)).rejects.toThrow('HH:MM');
  await enterRuleTime({user:hr,employeeId:1,date,checkIn:'09:30:01',checkOut:'17:00',version:1,reason:'Verified seconds'},db);
  expect(current(db)[0].measuredMinutes).toBeCloseTo(30+1/60);
 });
 it('requires the HR role even for an administrator and rejects future dates',async()=>{
  const db=fixture();await evaluate(db);
  await expect(enterRuleTime({user:{...hr,isAdmin:true,roles:['Admin']},employeeId:1,date,checkIn:'09:00',version:1,reason:'Try'},db)).rejects.toThrow('HR role');
  await expect(enterRuleTime({user:hr,employeeId:1,date,checkIn:'09:00',version:0,reason:'Stale'},db)).rejects.toThrow('Attendance changed');
 });
 it('preserves a compatible historical HR entry as immutable manual evidence and audits its original row',async()=>{
  const db=fixture([['17:00',1]]);
  await db.attendance.create({data:{tenantId:TENANT,employeeId:1,date:new Date(date),check_in:at('09:10'),check_out:at('17:00'),manually_corrected:true,corrected_by_id:2,correction_reason:'Historical verified entry'}});
  await evaluate(db);await evaluate(db);
  expect(db.snapshot().attendanceManualTime).toHaveLength(1);
  expect(db.snapshot().attendanceRuleAudit.filter(a=>a.action==='LEGACY_MANUAL_PRESERVED')).toHaveLength(1);
  expect(current(db).map(a=>a.type)).toEqual(['LATE_CHECKIN']);
 });
 it('preserves an already decided outcome while capture evidence is conflicting',async()=>{
  const db=fixture([['09:45',0],['17:00',1]]);await evaluate(db);let row=current(db)[0];
  await commentRuleCase({user:hr,anomalyId:row.id,version:0,kind:'HR',comment:'Verified'},db);row=current(db)[0];
  await prove(db,row);await finalizeRuleCase({user:management,anomalyId:row.id,version:row.workflowVersion,decision:'REJECTED',comment:'Disapproved'},db);
  await db.attendanceDevicePunch.create({data:{tenantId:TENANT,employeeId:1,punchedAt:at('12:00'),status:0,directionVerified:true,sn:'DEVICE-1'}});
  await evaluate(db);
  expect(current(db)[0].status).toBe('REJECTED');
  expect(db.snapshot().attendance[0].processingState).toBe('NEEDS_REVIEW');
 });
 it('converts absence to missing-out plus lateness, without a management decision or full-day credit',async()=>{
  const db=fixture();await evaluate(db);
  const absent=current(db)[0];expect(absent.type).toBe('ABSENT');
  await enterRuleTime({user:hr,employeeId:1,date,checkIn:'09:45',version:db.snapshot().attendance[0].evaluationVersion,reason:'CCTV verified arrival'},db);
  expect(current(db).map(a=>a.type).sort()).toEqual(['LATE_CHECKIN','MISSING_CHECKOUT']);
  expect(db.snapshot().attendanceAnomaly.find(a=>a.id===absent.id).status).toBe('RESOLVED');
  expect(db.snapshot().attendance[0].day_credit).toBeNull();
  expect(db.snapshot().attendanceManualTime[0]).toMatchObject({actorId:'hr-user',reason:'CCTV verified arrival'});
  expect(db.snapshot().attendanceRuleAudit.some(a=>a.action==='MANUAL_TIME_ENTERED')).toBe(true);
 });
 it('evaluates both manually supplied boundaries and rejects a second attempt to overwrite them',async()=>{
  const db=fixture();await evaluate(db);
  await enterRuleTime({user:hr,employeeId:1,date,checkIn:'13:00',checkOut:'14:00',version:1,reason:'Verified attendance'},db);
  expect(current(db).map(a=>a.type).sort()).toEqual(['EARLY_CHECKOUT','LATE_CHECKIN']);
  expect(db.snapshot().attendance[0]).toMatchObject({total_hours:1,day_credit:null});
  await expect(enterRuleTime({user:hr,employeeId:1,date,checkIn:'09:00',version:db.snapshot().attendance[0].evaluationVersion,reason:'Try replacement'},db)).rejects.toThrow('already recorded');
 });
 it('requires staged approval, current HR verification and the displayed version',async()=>{
  const db=fixture([['09:45',0],['17:00',1]]);await evaluate(db);let row=current(db)[0];
  for(const user of [hr,{...hr,isAdmin:true,roles:['Admin']},{...hr,employeeId:4,roles:['Manager']},management])await expect(finalizeRuleCase({user,anomalyId:row.id,version:row.workflowVersion,decision:'REJECTED',comment:'Disapprove'},db)).rejects.toThrow('Complete the employee, manager, HR and Management approval workflow');
  await prove(db,row);
  await expect(finalizeRuleCase({user:management,anomalyId:row.id,version:0,decision:'REJECTED',comment:'Disapprove'},db)).rejects.toThrow('HR must record verification');
  await commentRuleCase({user:hr,anomalyId:row.id,version:row.workflowVersion,kind:'HR',comment:'CCTV reviewed'},db);
  await expect(finalizeRuleCase({user:management,anomalyId:row.id,version:0,decision:'REJECTED',comment:'Disapprove'},db)).rejects.toThrow('Anomaly changed');
  row=current(db)[0];await finalizeRuleCase({user:management,anomalyId:row.id,version:row.workflowVersion,decision:'REJECTED',comment:'Unexcused late arrival'},db);
  expect(ruleDeductions(current(db)).days).toBe(.5);expect(db.snapshot().attendance[0].processingState).toBe('FINALIZED');
  expect(db.snapshot().attendanceRuleAudit.some(e=>e.action==='MANAGEMENT_DECISION')).toBe(true);
 });
 it('does not let an employee impersonate HR or comment on another tenant',async()=>{
  const db=fixture([['09:45',0],['17:00',1]]);await evaluate(db);const row=current(db)[0];
  await expect(commentRuleCase({user:{tenantId:TENANT,employeeId:1,userId:'self',roles:['Employee']},anomalyId:row.id,version:0,kind:'HR',comment:'Verified'},db)).rejects.toThrow('cannot comment');
  await expect(commentRuleCase({user:{...hr,tenantId:OTHER_TENANT},anomalyId:row.id,version:0,kind:'HR',comment:'Verified'},db)).rejects.toThrow('not found');
 });
 it('reverses a disapproved late anomaly after retroactive grace and retains the decision audit',async()=>{
  const db=fixture([['09:45',0],['17:00',1]]);await evaluate(db);let row=current(db)[0];
  await commentRuleCase({user:hr,anomalyId:row.id,version:0,kind:'HR',comment:'Verified'},db);row=current(db)[0];
  await prove(db,row);await finalizeRuleCase({user:management,anomalyId:row.id,version:row.workflowVersion,decision:'REJECTED',comment:'Not excused'},db);
  await saveGraceRule({user:hr,scope:'COMPANY',scopeKey:'*',effectiveFrom:date,checkInMinutes:45,checkOutMinutes:null,reason:'Revised company grace',version:-1},db);
  await evaluate(db);
  expect(current(db)).toHaveLength(0);expect(ruleDeductions(db.snapshot().attendanceAnomaly).days).toBe(0);
  expect(db.snapshot().attendanceRuleAudit.map(a=>a.action)).toEqual(expect.arrayContaining(['MANAGEMENT_DECISION','GRACE_CHANGED','OUTCOME_REVERSED']));
  expect(db.snapshot().attendanceEvaluationJob.some(j=>j.rulesReconciliation)).toBe(true);
 });
 it('keeps separate same-type cases for two scheduled shifts',async()=>{
  const db=fixture([],{shifts:[{from:'09:00',to:'12:00'},{from:'14:00',to:'17:00'}],offDays:[]});await evaluate(db);
  expect(current(db)).toHaveLength(2);expect(new Set(current(db).map(a=>a.sessionKey)).size).toBe(2);
  await expect(enterRuleTime({user:hr,employeeId:1,date,checkIn:'09:00',version:1,reason:'Verified'},db)).rejects.toThrow('specific scheduled shift');
 });
 it('employee and line-manager lists are scoped without trusting client employee IDs',async()=>{
  const db=fixture();await evaluate(db);
  expect((await listRuleCases({user:{...hr,roles:['Employee'],employeeId:9},from:date,to:date},db)).total).toBe(0);
  expect((await listRuleCases({user:{...hr,roles:['Manager'],employeeId:4},from:date,to:date},db)).total).toBe(1);
 });
});

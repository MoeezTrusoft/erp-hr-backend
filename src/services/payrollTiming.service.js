import prisma from '../lib/prisma.js';
import {shiftFor} from '../lib/attendanceReplay.js';
// Reuse the roster's overnight/rotating/weekday resolution. Never infer minutes from day_credit.
export async function enrichPayrollTiming({tenantId,payrollRun,employees,db=prisma}) {
 const ids=employees.map(e=>e.id);
 const [schedules,assignments,policy]=await Promise.all([
  db.workSchedule.findMany({where:{tenantId,employeeId:{in:ids},effective_start_date:{lte:payrollRun.periodEnd},OR:[{effective_end_date:null},{effective_end_date:{gte:payrollRun.periodStart}}]},orderBy:[{effective_start_date:'desc'},{id:'desc'}]}),
  db.shiftAssignment.findMany({where:{tenantId,employeeId:{in:ids},date:{gte:payrollRun.periodStart,lte:payrollRun.periodEnd}},orderBy:{id:'desc'}}),
  db.attendancePolicyConfig.findUnique({where:{tenantId}}),
 ]);
 const key=d=>new Date(d).toISOString().slice(0,10);
 for(const employee of employees) {
  for(const row of employee.attendance||[]) {
   const schedule=schedules.find(s=>s.employeeId===employee.id && key(s.effective_start_date)<=key(row.date) && (!s.effective_end_date||key(s.effective_end_date)>=key(row.date)));
   const assignment=assignments.find(s=>s.employeeId===employee.id && key(s.date)===key(row.date));
   const pattern=assignment?.fromTime&&assignment?.toTime?{shift:{from:assignment.fromTime,to:assignment.toTime}}:schedule?.schedule_pattern;
   const shift=shiftFor(pattern,row.date,row.check_in);
   const minutes=(type,actual,expected)=>{
    const snapshot=(employee.attendanceAnomalies||[]).find(a=>a.type===type&&key(a.date)===key(row.date)&&a.expectedTime&&a.actualTime);
    // The effective roster and recorded punches outrank old evaluator snapshots.
    // Snapshot timestamps are fallback evidence only when a source is missing.
    const a=actual||snapshot?.actualTime,e=expected||snapshot?.expectedTime;
    if(!a||!e) return null;
    let diff=(new Date(a)-new Date(e))/60000;
    if(type==='LATE_CHECKIN') {if(diff>720)diff-=1440;if(diff < -720)diff+=1440;return diff>(policy?.graceMinutes||0)?diff:0;}
    return -diff>(policy?.earlyLeaveGraceMin||0)?-diff:0;
   };
   row.lateMinutes=minutes('LATE_CHECKIN',row.check_in,shift.start);
   row.earlyMinutes=minutes('EARLY_CHECKOUT',row.check_out,shift.end);
  }
 }
}

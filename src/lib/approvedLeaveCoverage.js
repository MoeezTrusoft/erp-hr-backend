// Convert approved leave ranges into payroll-only shift exemptions. Stored
// requests, attendance facts, and approval decisions are not modified.
const day = value => value == null ? null : new Date(value).toISOString().slice(0,10);
export function approvedLeaveCoverage(requests, periodStart, periodEnd) {
 const start=day(periodStart), end=day(periodEnd), days=new Map();
 for(const leave of requests) {
  if(leave.status!=='APPROVED') continue;
  const from=day(leave.startDate??leave.start_date), to=day(leave.endDate??leave.end_date);
  if(!from||!to) continue;
  const first=from>start?from:start, last=to<end?to:end;
  for(let d=new Date(first+'T00:00:00Z');day(d)<=last;d.setUTCDate(d.getUTCDate()+1)) {
   const date=day(d), key=`${leave.employeeId}|${date}`;
   days.set(key,{employeeId:leave.employeeId,date:new Date(date+'T00:00:00Z'),status:'APPROVED',sourceKind:'PAYROLL_LEAVE_COVERAGE'});
  }
 }
 return [...days.values()];
}

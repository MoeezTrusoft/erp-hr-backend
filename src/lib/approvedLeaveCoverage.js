// Convert approved leave days into payroll-only shift exemptions. Stored
// requests, attendance facts, and approval decisions are not modified.
// `days` are approvedLeaveDays() rows ({employeeId, date 'YYYY-MM-DD'}): a day
// Management rejected inside an approved request is not among them.
const day = value => value == null ? null : new Date(value).toISOString().slice(0,10);
export function approvedLeaveCoverage(days, periodStart, periodEnd) {
 const start=day(periodStart), end=day(periodEnd), out=new Map();
 for(const row of days) {
  const date=day(row.date);
  if(!date||date<start||date>end) continue;
  out.set(`${row.employeeId}|${date}`,{employeeId:row.employeeId,date:new Date(date+'T00:00:00Z'),status:'APPROVED',sourceKind:'PAYROLL_LEAVE_COVERAGE'});
 }
 return [...out.values()];
}

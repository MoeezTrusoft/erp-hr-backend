export const HEADEND_TENANT = '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73';
export const HEADEND_OFFICE = 'HVC-Headend-Staff';
// Kept as an export alias for callers; eligibility is now explicit configuration.
export const isManualMonthlyEmployee = employee => employee?.attendanceInputMode === 'MANUAL_MONTHLY';
export const isHeadendEmployee = isManualMonthlyEmployee;
const fail = message => { throw Object.assign(new Error(message), {status:400}); };
export function payrollMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) fail('Use YYYY-MM for the payroll month');
  const start = new Date(`${month}-01T00:00:00.000Z`);
  if (start.getUTCFullYear() < 1900) fail('Invalid payroll year');
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth()+1, 1)-1);
  return {start, end, days:end.getUTCDate()};
}
export function validatePayableDays(month, value) {
  const {days}=payrollMonth(month);
  if (value===null || value===undefined || value==='' || !Number.isFinite(Number(value)) || Number(value)<0 || Number(value)>days || !Number.isInteger(Number(value)*2)) fail(`Payable days must be 0 to ${days}, in half-day increments`);
  return Number(value);
}
export function manualAttendanceFactor(employee, run, input, employmentFactor) {
  if (!isHeadendEmployee(employee)) return employmentFactor;
  const month=run.periodStart.toISOString().slice(0,7), calendar=payrollMonth(month);
  // Compare civil dates: runs created from the UI/MCP carry the dates at midnight
  // (e.g. periodEnd 2026-09-30T00:00:00Z), and a full month must still qualify.
  const civil = d => d.toISOString().slice(0,10);
  if (civil(run.periodStart)!==civil(calendar.start) || civil(run.periodEnd)!==civil(calendar.end)) fail('Manual monthly attendance requires a full calendar-month payroll');
  // §362 — the entered row IS the input. A missing row used to fall back to
  // min(30, month days, employment span), i.e. a silent full month; the payroll
  // readiness gate refuses the calculation first, this keeps the engine honest.
  if (!input) throw Object.assign(new Error(`Monthly payable days are missing for employee ${employee.id} (${month})`), {status:409, code:'MONTHLY_ATTENDANCE_REQUIRED'});
  if (input.month!==month) fail(`Monthly payable days are missing for employee ${employee.id} (${month})`);
  const days=validatePayableDays(month,input.payableDays);
  // Allow the tiny rounding error of the engine's millionth-day proration.
  if (days > Number(employmentFactor)*calendar.days/1000000 + 0.0001) fail(`Payable days exceed employment days for employee ${employee.id}`);
  return BigInt(Math.round(days/calendar.days*1000000));
}
export function groupOfficePayroll(rows) {
  const groups=new Map();
  for(const row of rows){
    const office=row.payrollOffice || 'Unassigned office';
    if(!groups.has(office)) groups.set(office,{office,employees:[],gross:0,deductions:0,net:0});
    const g=groups.get(office);g.employees.push(row);
    g.gross+=Number(row.grossAmount);g.deductions+=Number(row.totalDeductions);g.net+=Number(row.netAmount);
  }
  const offices=[...groups.values()].sort((a,b)=>a.office.localeCompare(b.office));
  const totals=offices.reduce((a,g)=>({employees:a.employees+g.employees.length,gross:a.gross+g.gross,deductions:a.deductions+g.deductions,net:a.net+g.net}),{employees:0,gross:0,deductions:0,net:0});
  return {offices,totals};
}

import prisma from '../lib/prisma.js';
import {tenantTransaction} from '../lib/rlsTenant.js';
import {payrollMonth,validatePayableDays,groupOfficePayroll} from '../lib/monthlyPayrollAttendance.js';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const name=e=>e.employee_name || [e.first_name,e.last_name].filter(Boolean).join(' ');
export async function assertMonthlyEditable(tx,tenantId,month){
  const {start,end}=payrollMonth(month);
  const runs=await tx.payrollRun.findMany({where:{tenantId,periodStart:{lte:end},periodEnd:{gte:start},status:{notIn:['CANCELLED','FAILED']}},select:{id:true,status:true}});
  if(runs.some(r=>r.status!=='PENDING')) fail(409,'Recall or cancel the processed payroll before editing monthly attendance');
  if(runs.length && await tx.payrollAuditLog.count({where:{tenantId,payrollRunId:{in:runs.map(r=>r.id)},action:'TIMESHEET_SUBMITTED'}})) fail(409,'Unsubmit the timesheet before editing monthly attendance');
}
export async function listMonthlyAttendance({tenantId,month}){
  payrollMonth(month);
  const [employees,entries]=await Promise.all([
    prisma.employee.findMany({where:{tenant_id:tenantId,payroll_included:{not:false}},select:{id:true,employee_code:true,employee_name:true,first_name:true,last_name:true,payrollOffice:true,attendanceInputMode:true,version:true},orderBy:{id:'asc'}}),
    prisma.monthlyPayrollAttendance.findMany({where:{tenantId,month}}),
  ]);
  const byId=new Map(entries.map(r=>[r.employeeId,r]));
  return {month,days:payrollMonth(month).days,items:employees.map(e=>({id:e.id,name:name(e),code:e.employee_code,office:e.payrollOffice,mode:e.attendanceInputMode,employeeVersion:e.version,entry:byId.get(e.id)||null}))};
}
export async function saveMonthlyAttendance({tenantId,employeeId,month,payableDays,reason,version,actorId}){
  const days=validatePayableDays(month,payableDays);
  if(!reason?.trim()) fail(400,'A reason or attendance source is required');
  return tenantTransaction(prisma,async tx=>{
    const employee=await tx.employee.findFirst({where:{id:employeeId,tenant_id:tenantId},select:{id:true,attendanceInputMode:true}});
    if(!employee) fail(404,'Employee not found');
    if(employee.attendanceInputMode!=='MANUAL_MONTHLY') fail(400,'Employee does not use monthly manual attendance');
    await assertMonthlyEditable(tx,tenantId,month);
    const previous=await tx.monthlyPayrollAttendance.findFirst({where:{tenantId,employeeId,month}});
    if((previous?.version||0)!==version) fail(409,'Attendance changed; refresh before saving');
    let saved;
    if(previous){
      const result=await tx.monthlyPayrollAttendance.updateMany({where:{id:previous.id,tenantId,version},data:{payableDays:days,reason:reason.trim(),updatedById:actorId,version:{increment:1}}});
      if(result.count!==1) fail(409,'Attendance changed; refresh before saving');
      saved=await tx.monthlyPayrollAttendance.findFirst({where:{id:previous.id,tenantId}});
    }else saved=await tx.monthlyPayrollAttendance.create({data:{tenantId,employeeId,month,payableDays:days,reason:reason.trim(),updatedById:actorId}});
    await tx.payrollAuditLog.create({data:{tenantId,employeeId,action:'MONTHLY_ATTENDANCE_SAVED',details:JSON.stringify({month,actorId,reason:reason.trim(),previousDays:previous?.payableDays?.toString()??null,payableDays:days,version:saved.version})}});
    return saved;
  },{tenantId,txOptions:{isolationLevel:'Serializable'}});
}
export async function assignPayrollOffice({tenantId,employeeId,office,mode,version,reason,actorId}){
  if(!office?.trim() || office.trim().length>100 || !['DEVICE','MANUAL_MONTHLY'].includes(mode) || !reason?.trim()) fail(400,'Office, attendance method and reason are required');
  return tenantTransaction(prisma,async tx=>{
    const previous=await tx.employee.findFirst({where:{tenant_id:tenantId,id:employeeId},select:{id:true,version:true,payrollOffice:true,attendanceInputMode:true}});
    if(!previous) fail(404,'Employee not found');
    if(previous.version!==version) fail(409,'Employee changed; refresh before saving');
    const busy=await tx.payrollRun.findFirst({where:{tenantId,status:{in:['PROCESSING','COMPLETED','APPROVED']}}});
    if(busy) fail(409,'Finish or cancel open payroll processing before changing office or attendance method');
    const changed=await tx.employee.updateMany({where:{id:employeeId,tenant_id:tenantId,version},data:{payrollOffice:office.trim(),attendanceInputMode:mode,version:{increment:1}}});
    if(changed.count!==1) fail(409,'Employee changed; refresh before saving');
    await tx.payrollAuditLog.create({data:{tenantId,employeeId,action:'PAYROLL_OFFICE_ASSIGNED',details:JSON.stringify({actorId,reason:reason.trim(),previous:{office:previous.payrollOffice,mode:previous.attendanceInputMode},office:office.trim(),mode})}});
    return {id:employeeId,office:office.trim(),mode,version:version+1};
  },{tenantId,txOptions:{isolationLevel:'Serializable'}});
}
export async function getOfficePayroll({tenantId,runId}){
  const run=await prisma.payrollRun.findFirst({where:{tenantId,id:runId}});
  if(!run) fail(404,'Payroll run not found');
  const rows=await prisma.payrollPayslip.findMany({where:{tenantId,payrollRunId:runId},select:{id:true,employeeId:true,payrollOffice:true,attendanceInputMode:true,payableDays:true,grossAmount:true,totalDeductions:true,netAmount:true,employee:{select:{employee_name:true,first_name:true,last_name:true,employee_code:true}}},orderBy:{employeeId:'asc'}});
  return {runId,currencyCode:run.currencyCode,periodStart:run.periodStart,periodEnd:run.periodEnd,...groupOfficePayroll(rows.map(r=>({...r,name:name(r.employee),code:r.employee.employee_code,employee:undefined})))};
}
export async function assertMonthlyInputsComplete({tenantId,month}){
  const {start,end}=payrollMonth(month);
  const employees=await prisma.employee.findMany({where:{tenant_id:tenantId,attendanceInputMode:'MANUAL_MONTHLY',payroll_included:{not:false},OR:[{status:{equals:'active',mode:'insensitive'}},{employmentPeriods:{some:{startDate:{lte:end},OR:[{endDate:null},{endDate:{gte:start}}]}}}]},select:{id:true}});
  const entries=await prisma.monthlyPayrollAttendance.findMany({where:{tenantId,month},select:{employeeId:true,payableDays:true}});
  const byId=new Map(entries.map(r=>[r.employeeId,r]));
  const missing=employees.filter(e=>!byId.has(e.id));
  if(missing.length) fail(409,`Monthly payable days are required for ${missing.length} employees before submitting payroll`);
}

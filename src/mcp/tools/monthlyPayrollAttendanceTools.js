import {z} from 'zod';
import {mcpCtx} from '../context.js';
import {assertPermission} from '../utils/assertPermission.js';
import {withToolError} from '../utils/toolError.js';
import {listMonthlyAttendance,saveMonthlyAttendance,assignPayrollOffice,getOfficePayroll} from '../../services/monthlyPayrollAttendance.service.js';
export function registerMonthlyPayrollAttendanceTools(server){
  const register=(name,schema,method,fn)=>server.tool(name,name.replaceAll('_',' '),schema,withToolError(async args=>{
    const ctx=mcpCtx.getStore(); if(!ctx?.user?.tenantId) throw Object.assign(new Error('Unauthenticated'),{status:401});
    assertPermission(ctx.permissions,method,'hr:payroll',ctx.user.isAdmin);
    const actorId=Number(ctx.user.employeeId); if(method!=='GET' && (!Number.isInteger(actorId) || actorId<=0)) throw Object.assign(new Error('An employee identity is required'),{status:401});
    const result=await fn({...args,tenantId:ctx.user.tenantId,actorId});
    return {content:[{type:'text',text:JSON.stringify(result)}]};
  },name));
  const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), employeeId=z.number().int().positive();
  register('hr_payroll_monthly_attendance_list',{month},'GET',listMonthlyAttendance);
  register('hr_payroll_monthly_attendance_save',{employeeId,month,payableDays:z.number().min(0).max(31).multipleOf(0.5),reason:z.string().trim().min(1).max(2000),version:z.number().int().min(0)},'PUT',saveMonthlyAttendance);
  register('hr_payroll_office_assign',{employeeId,office:z.string().trim().min(1).max(100),mode:z.enum(['DEVICE','MANUAL_MONTHLY']),version:z.number().int().min(0),reason:z.string().trim().min(1).max(2000)},'PUT',assignPayrollOffice);
  register('hr_payroll_office_summary',{runId:z.number().int().positive()},'GET',getOfficePayroll);
}

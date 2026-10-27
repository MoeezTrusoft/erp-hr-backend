import { z } from 'zod';
import { mcpCtx } from '../context.js';
import { assertPermission } from '../utils/assertPermission.js';
import { withToolError } from '../utils/toolError.js';
import { previewPayslip } from '../../services/payrollPreview.service.js';
import { assertPayrollAdminSurface } from '../utils/actorScope.js';
export function registerPayrollPreviewTools(server) {
  server.tool('hr_payroll_test_payslip','Preview an employee code using the production payroll engine without saving',{
    runId:z.coerce.number().int().positive(),employeeCode:z.string().trim().min(1).max(50),
  },withToolError(async args=>{
    const {user,permissions}=mcpCtx.getStore() || {};
    if(!user) throw Object.assign(new Error('Unauthenticated'),{status:401});
    assertPermission(permissions,'GET','hr:payroll',user.isAdmin);
    assertPayrollAdminSurface(permissions);
    return {content:[{type:'text',text:JSON.stringify(await previewPayslip({...args,tenantId:user.tenantId}))}]};
  },'hr_payroll_test_payslip'));
}

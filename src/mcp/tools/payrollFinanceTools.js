import { PAYROLL_FINANCE_TOOLS, PAYROLL_FINANCE_INPUTS } from '@trusoft/contracts/payroll-finance';
import prisma from '../../lib/prisma.js';
import { createPayrollFinanceService } from '../../services/payrollFinance.service.js';
import { getCtx } from '../context.js';
import { assertPermission } from '../utils/assertPermission.js';
import { assertPayrollAdminSurface } from '../utils/actorScope.js';
import { withToolError } from '../utils/toolError.js';
export function registerPayrollFinanceTools(server) {
  const service = createPayrollFinanceService(prisma);
  for (const tool of PAYROLL_FINANCE_TOOLS) {
    const action = tool.name.split('_').at(-1), schema = PAYROLL_FINANCE_INPUTS[tool.name];
    server.tool(tool.name, tool.description, schema.shape, withToolError(async args => {
      const ctx = getCtx();
      assertPermission(ctx.permissions, action === 'list' ? 'GET' : action === 'prepare' ? 'POST' : 'PUT', 'hr:payroll', ctx.user.isAdmin);
      if (!ctx.user.isAdmin) assertPayrollAdminSurface(ctx.permissions);
      const result = await service[action](ctx, schema.parse(args));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }));
  }
}

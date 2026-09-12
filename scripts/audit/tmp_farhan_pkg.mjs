import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';
const TRUSOFT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
await mcpCtx.run({ system: true }, async () => {
  const emp = await prisma.employee.findFirst({
    where: { id: 497, tenant_id: TRUSOFT },
    include: {
      payrollAssignments: {
        where: { isActive: true },
        include: {
          salaryComponents: { include: { component: true } },
          employmentTerms: true,
        },
      },
    },
  });
  if (!emp) { console.log('Farhan (497) not found'); return; }
  console.log('Farhan: ' + emp.first_name + ' ' + emp.last_name + ' | code=' + emp.employee_code);
  console.log('Assignments:');
  for (const a of emp.payrollAssignments) {
    console.log('  Assignment: ' + a.startDate + ' to ' + a.endDate + ' | isActive=' + a.isActive);
    console.log('  EmploymentTerms: ' + (a.employmentTerms?.effectiveFrom ?? 'none') + ' to ' + (a.employmentTerms?.effectiveTo ?? 'open'));
    let total = 0;
    for (const c of a.salaryComponents) {
      console.log('    Component: ' + (c.component?.name ?? '?') + ' | amount=' + c.amount);
      total += Number(c.amount);
    }
    console.log('    TOTAL package: ' + total);
  }
});
await prisma.$disconnect();

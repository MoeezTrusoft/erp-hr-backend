import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';
const TRUSOFT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
await mcpCtx.run({ system: true }, async () => {
  const slips = await prisma.payrollPayslip.findMany({
    where: { tenantId: TRUSOFT, payrollRunId: 12, employeeId: 493 },
    include: { deductions: { include: { deductionType: true } } },
  });
  for (const s of slips) {
    console.log('Obaid (id=493) gross=' + Number(s.grossAmount).toFixed(2) + ' net=' + Number(s.netAmount).toFixed(2) + ' totalDed=' + Number(s.totalDeductions).toFixed(2));
    console.log('Deductions:');
    for (const d of s.deductions) {
      console.log('  ' + (d.deductionType?.name ?? '?') + ' | ' + (d.description ?? '') + ' | ' + Number(d.amount).toFixed(2));
    }
  }
});
await prisma.$disconnect();

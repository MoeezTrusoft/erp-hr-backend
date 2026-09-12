// Why does Meesam (PDF net 32,803 = 32,903.22 - 100) get 0 tax while Obaid
// (same 60K package, net 56,029 = 56,129.04 - 100) gets 100?
// Dump both payslip deduction lines from run 12.
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

const TEN = '40314ef4-0a81-4390-b631-b3ad3f21f523';

await mcpCtx.run({ system: true }, async () => {
  const slips = await prisma.payrollPayslip.findMany({
    where: { tenantId: TEN, payrollRunId: 12 },
    include: {
      employee: { select: { id: true, first_name: true, last_name: true } },
      deductions: { include: { deductionType: true } },
    },
    orderBy: { employeeId: 'asc' },
  });
  for (const s of slips) {
    const name = `${s.employee.first_name ?? ''} ${s.employee.last_name ?? ''}`.trim();
    if (!/meesam|obaid/i.test(name)) continue;
    console.log(`\n=== ${name} (id=${s.employee.id}) gross=${Number(s.grossAmount).toFixed(2)} totalDed=${Number(s.totalDeductions).toFixed(2)} net=${Number(s.netAmount).toFixed(2)} ===`);
    for (const d of s.deductions) {
      console.log(`  [${d.deductionType?.name ?? '?'}] ${d.description ?? ''} amount=${Number(d.amount).toFixed(2)}`);
    }
  }
});
await prisma.$disconnect();
process.exit(0);

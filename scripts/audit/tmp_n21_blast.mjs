// Show prorated employees in runs 13-16 and their tax lines (N-21 blast radius).
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

await mcpCtx.run({ system: true }, async () => {
  const slips = await prisma.payrollPayslip.findMany({
    where: { payrollRunId: { in: [13, 14, 15, 16] } },
    include: {
      employee: { select: { first_name: true, last_name: true } },
      earnings: true,
      deductions: { include: { deductionType: true } },
    },
  });
  let n = 0;
  for (const s of slips) {
    const prorated = s.earnings.filter((e) => /prorated/i.test(e.description || ''));
    if (!prorated.length) continue;
    n++;
    const name = `${s.employee.first_name} ${s.employee.last_name ?? ''}`.trim();
    const tax = s.deductions
      .filter((d) => /tax/i.test(d.deductionType?.name || ''))
      .reduce((t, d) => t + Number(d.amount), 0);
    console.log(`run ${s.payrollRunId} | ${name} | ${prorated.map((e) => e.description).join('; ')} | tax=${tax.toFixed(2)}`);
  }
  console.log(`(prorated employees in runs 13-16: ${n})`);
});
await prisma.$disconnect();
process.exit(0);

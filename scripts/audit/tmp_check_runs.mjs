import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';
const TRUSOFT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
await mcpCtx.run({ system: true }, async () => {
  console.log('=== Payroll runs for Trusoft ===');
  const runs = await prisma.payrollRun.findMany({
    where: { tenantId: TRUSOFT },
    orderBy: { id: 'desc' },
    include: { _count: { select: { payslips: true } } },
  });
  for (const r of runs) {
    console.log('Run ' + r.id + ' | ' + r.status + ' | period=' + r.periodStart + ' to ' + r.periodEnd + ' | ' + r._count.payslips + ' payslips | created=' + r.createdAt);
  }
  console.log('\n=== All runs across tenants (last 20) ===');
  const all = await prisma.payrollRun.findMany({
    orderBy: { id: 'desc' },
    take: 20,
    include: { _count: { select: { payslips: true } } },
  });
  for (const r of all) {
    console.log('Run ' + r.id + ' | tenant=' + r.tenantId + ' | ' + r.status + ' | ' + r._count.payslips + ' slips');
  }
});
await prisma.$disconnect();

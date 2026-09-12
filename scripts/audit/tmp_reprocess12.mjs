// Reprocess run 12 (Trusoft) after the A.Moiz hire-date fix; report 486 slip.
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';
import { processPayrollRun } from '../src/services/payrollService.js';

const TEN = '40314ef4-0a81-4390-b631-b3ad3f21f523';

await mcpCtx.run({ system: true }, async () => {
  await processPayrollRun(12, undefined, TEN);
  const r = await prisma.payrollRun.findUnique({ where: { id: 12 }, select: { status: true, employeeCount: true, totalGross: true, totalDeductions: true, totalNet: true } });
  console.log(`run 12: status=${r.status} employees=${r.employeeCount} gross=${r.totalGross} ded=${r.totalDeductions} net=${r.totalNet}`);
  const s = await prisma.payrollPayslip.findFirst({ where: { payrollRunId: 12, employeeId: 486 }, include: { earnings: true, deductions: true } });
  console.log('486 gross:', String(s?.grossAmount), 'net:', String(s?.netAmount));
  console.log('486 earnings:', JSON.stringify(s?.earnings.map((e) => ({ t: e.earningTypeId, a: String(e.amount) }))));
});
await prisma.$disconnect();
process.exit(0);

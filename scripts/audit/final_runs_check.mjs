// Post-deploy final check: August runs 12-16 intact with expected payslip counts.
import { mcpCtx } from '../../src/mcp/context.js';
import prisma from '../../src/lib/prisma.js';

const EXPECT = { 12: 16, 13: 32, 14: 15, 15: 6, 16: 3 };

await mcpCtx.run({ system: true }, async () => {
  for (const [id, expect] of Object.entries(EXPECT)) {
    const [run, slips] = await Promise.all([
      prisma.payrollRun.findUnique({
        where: { id: Number(id) },
        select: { status: true, employeeCount: true, totalNet: true },
      }),
      prisma.payrollPayslip.count({ where: { payrollRunId: Number(id) } }),
    ]);
    const ok = slips === expect && run.status === 'COMPLETED';
    console.log(`run ${id}: status=${run.status} slips=${slips}/${expect} net=${run.totalNet} ${ok ? 'OK' : '*** MISMATCH ***'}`);
  }
});
await prisma.$disconnect();
process.exit(0);

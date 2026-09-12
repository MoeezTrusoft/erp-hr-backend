// Reprocess runs 13-16 (Homenet, HomeVision, JOC, BOC) under the N-21 engine.
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';
import { processPayrollRun } from '../src/services/payrollService.js';

const RUNS = [
  [13, '8ff0533b-62f6-4be9-a78e-69adf49e00bc'],
  [14, '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73'],
  [15, '8f4a526f-d45b-4da2-b772-d6682e849812'],
  [16, '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2'],
];

await mcpCtx.run({ system: true }, async () => {
  for (const [runId, tenantId] of RUNS) {
    await processPayrollRun(runId, undefined, tenantId);
    const r = await prisma.payrollRun.findUnique({
      where: { id: runId },
      select: { status: true, employeeCount: true, totalGross: true, totalDeductions: true, totalNet: true },
    });
    console.log(`run ${runId}: status=${r.status} employees=${r.employeeCount} gross=${r.totalGross} ded=${r.totalDeductions} net=${r.totalNet}`);
  }
});
await prisma.$disconnect();
process.exit(0);

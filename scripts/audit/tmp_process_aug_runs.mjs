// Phase 6.2 — process the August runs (ids 12..16) through the real engine.
import { mcpCtx } from '../src/mcp/context.js';
import { processPayrollRun } from '../src/services/payrollService.js';

const RUNS = [
  [12, 'TRUSOFT', '40314ef4-0a81-4390-b631-b3ad3f21f523'],
  [13, 'HOMENET', '8ff0533b-62f6-4be9-a78e-69adf49e00bc'],
  [14, 'HOMEVISION', '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73'],
  [15, 'JOC', '8f4a526f-d45b-4da2-b772-d6682e849812'],
  [16, 'BOC', '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2'],
];

await mcpCtx.run({ system: true }, async () => {
  for (const [id, label, tenantId] of RUNS) {
    try {
      const run = await processPayrollRun(id, undefined, tenantId);
      const r = await (await import('../src/lib/prisma.js')).default.payrollRun.findUnique({
        where: { id },
        select: { status: true, employeeCount: true, totalGross: true, totalDeductions: true, totalNet: true, processedAt: true },
      });
      console.log(`${label}: status=${r.status} employees=${r.employeeCount} gross=${r.totalGross} ded=${r.totalDeductions} net=${r.totalNet}`);
    } catch (e) {
      console.log(`${label}: PROCESS FAILED — ${e.message.slice(0, 300)}`);
    }
  }
});
process.exit(0);

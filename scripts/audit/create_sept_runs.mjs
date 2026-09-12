// Create September 2026 payroll run skeletons (PENDING, unprocessed) for all
// five tenants. Period 2026-09-01 .. 2026-09-30 (23:59:59.999 end convention).
// Holidays are NOT seeded — HR marks September holidays in the app before
// month-end; no dates invented here (operator ruling 2026-09-12).
import { mcpCtx } from '../../src/mcp/context.js';
import { createPayrollRun } from '../../src/services/payrollService.js';
import prisma from '../../src/lib/prisma.js';

const TENANTS = [
  ['40314ef4-0a81-4390-b631-b3ad3f21f523', 'TRUSOFT'],
  ['8ff0533b-62f6-4be9-a78e-69adf49e00bc', 'HOMENET'],
  ['61b7eb53-ab6e-413f-9d9a-1ecf4e071e73', 'HOMEVISION'],
  ['8f4a526f-d45b-4da2-b772-d6682e849812', 'JOC'],
  ['14d8c7b1-194d-4e35-b058-b9cb9aa9fba2', 'BOC'],
];

await mcpCtx.run({ system: true }, async () => {
  for (const [tenantId, label] of TENANTS) {
    // Idempotent: skip if a September run already exists for the tenant.
    const existing = await prisma.payrollRun.findFirst({
      where: {
        tenantId,
        periodStart: { gte: new Date('2026-09-01T00:00:00.000Z'), lt: new Date('2026-10-01T00:00:00.000Z') },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      console.log(`${label}: September run already exists (id=${existing.id}, status=${existing.status}) — skipped`);
      continue;
    }
    try {
      const run = await createPayrollRun({
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        periodEnd: new Date('2026-09-30T23:59:59.999Z'),
        countryCode: 'PK',
        currencyCode: 'PKR',
      }, undefined, tenantId);
      console.log(`${label}: September skeleton created — run id=${run.id} status=${run.status}`);
    } catch (e) {
      console.log(`${label}: CREATE FAILED — ${e.message.slice(0, 140)}`);
    }
  }
});
await prisma.$disconnect();
process.exit(0);

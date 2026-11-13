// Phase 6.1 — create the August 2026 payroll run per tenant (5 tenants).
// Period: 2026-08-01 .. 2026-08-31 (end at 23:59:59.999 per engine convention).
import { mcpCtx } from '../src/mcp/context.js';
import { createPayrollRun } from '../src/services/payrollService.js';

const TENANTS = [
  ['40314ef4-0a81-4390-b631-b3ad3f21f523', 'TRUSOFT'],
  ['8ff0533b-62f6-4be9-a78e-69adf49e00bc', 'HOMENET'],
  ['61b7eb53-ab6e-413f-9d9a-1ecf4e071e73', 'HOMEVISION'],
  ['8f4a526f-d45b-4da2-b772-d6682e849812', 'JOC'],
  ['14d8c7b1-194d-4e35-b058-b9cb9aa9fba2', 'BOC'],
];

await mcpCtx.run({ system: true }, async () => {
  for (const [tenantId, label] of TENANTS) {
    try {
      const run = await createPayrollRun({
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-31T23:59:59.999Z'),
        countryCode: 'PK',
        currencyCode: 'PKR',
      }, undefined, tenantId);
      console.log(`${label}: run id=${run.id} status=${run.status}`);
    } catch (e) {
      console.log(`${label}: CREATE FAILED — ${e.message.slice(0, 140)}`);
    }
  }
});
process.exit(0);

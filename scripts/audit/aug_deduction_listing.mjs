// AUGUST 2026 — full itemized deduction listing, all 5 tenants (runs 12-16).
// One line per PayrollDeduction row: type, description, amount.
// Read-only; runs with system context and prints a compact review sheet.
import { mcpCtx } from '../../src/mcp/context.js';
import prisma from '../../src/lib/prisma.js';

const RUNS = [
  [12, 'TRUSOFT', '40314ef4-0a81-4390-b631-b3ad3f21f523'],
  [13, 'HOMENET', '8ff0533b-62f6-4be9-a78e-69adf49e00bc'],
  [14, 'HOMEVISION', '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73'],
  [15, 'JOC', '8f4a526f-d45b-4da2-b772-d6682e849812'],
  [16, 'BOC', '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2'],
];

await mcpCtx.run({ system: true }, async () => {
  for (const [runId, label] of RUNS) {
    const slips = await prisma.payrollPayslip.findMany({
      where: { payrollRunId: runId },
      include: {
        employee: { select: { first_name: true, last_name: true } },
        deductions: {
          include: { deductionType: { select: { code: true, name: true } } },
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { employeeId: 'asc' },
    });
    console.log(`\n########## ${label} (run ${runId}) — ${slips.length} payslips ##########`);
    let tenantGross = 0, tenantDed = 0, tenantNet = 0;
    for (const s of slips) {
      const name = `${s.employee.first_name ?? ''} ${s.employee.last_name ?? ''}`.trim();
      const gross = Number(s.grossAmount), tot = Number(s.totalDeductions), net = Number(s.netAmount);
      tenantGross += gross; tenantDed += tot; tenantNet += net;
      console.log(`\n${name}  | gross ${gross.toFixed(2)} | deductions ${tot.toFixed(2)} | net ${net.toFixed(2)}`);
      if (s.deductions.length === 0) console.log('   (no deduction lines)');
      for (const d of s.deductions) {
        const t = d.deductionType ? `${d.deductionType.code}/${d.deductionType.name}` : `typeId=${d.deductionTypeId}`;
        const desc = d.description ? ` — ${d.description}` : '';
        console.log(`   - ${t}${desc}: ${Number(d.amount).toFixed(2)}`);
      }
    }
    console.log(`\n--- ${label} TOTALS: gross=${tenantGross.toFixed(2)} ded=${tenantDed.toFixed(2)} net=${tenantNet.toFixed(2)}`);
  }
});
await prisma.$disconnect();
process.exit(0);

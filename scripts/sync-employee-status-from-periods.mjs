// One-time data sync — employee status from employment periods.
//
// Affan(490), Afzal(494), Shizza(496) were TERMINATED 31 July (employment_periods
// carry endDate + reason='termination') but employement_status still reads
// 'Active', so they appear in every "active employee" surface (directory,
// schedules selector, coverage audits). Obaid (terminated 8 Sep) and Meesam
// (rehired 7 Sep) need the same check.
//
// Rule (idempotent — safe to re-run):
//   latest employment period per employee  →  endDate null (open)  →  Active
//   latest employment period per employee  →  endDate ≤ today      →  Inactive
//   (a future-dated period end leaves the current status untouched)
// Never flips Inactive → Active unless an OPEN period exists (rehire), so a
// manually-terminated row without a period stays Inactive.
//
// Usage: node /app/scripts/sync-employee-status-from-periods.mjs [--dry-run]
import { mcpCtx } from '../src/mcp/context.js';

const DRY = process.argv.includes('--dry-run');

await mcpCtx.run({ system: true }, async () => {
  const { default: prisma } = await import('../src/lib/prisma.js');

  const employees = await prisma.employee.findMany({
    select: { id: true, first_name: true, last_name: true, employement_status: true, tenant_id: true },
  });

  const periods = await prisma.employmentPeriod.findMany({
    orderBy: [{ employeeId: 'asc' }, { startDate: 'asc' }],
    select: { employeeId: true, startDate: true, endDate: true, reason: true },
  });

  const latestByEmployee = new Map();
  for (const p of periods) {
    latestByEmployee.set(p.employeeId, p); // last row per employee = latest start
  }

  let flipped = 0;
  let kept = 0;
  for (const e of employees) {
    const period = latestByEmployee.get(e.id);
    let derived;
    if (period) {
      if (period.endDate == null) derived = 'Active';
      else if (period.endDate.getTime() <= Date.now()) derived = 'Inactive';
      else derived = e.employement_status || 'Active'; // future end — leave as-is
    } else {
      derived = e.employement_status || 'Active'; // no periods — legacy rows stay
    }

    const current = e.employement_status || 'Active';
    if (derived === current) {
      kept += 1;
      continue;
    }

    flipped += 1;
    console.log(
      `   #${e.id} ${e.first_name} ${e.last_name}: ${current} → ${derived}` +
        (period?.endDate ? ` (period ended ${period.endDate.toISOString().slice(0, 10)}${period.reason ? `, ${period.reason}` : ''})` : ' (open period)')
    );
    if (!DRY) {
      await prisma.employee.update({
        where: { id: e.id },
        data: { employement_status: derived },
      });
    }
  }

  console.log(`\nSUMMARY employees=${employees.length} flipped=${flipped} kept=${kept}${DRY ? ' (DRY RUN — nothing written)' : ''}`);
  await prisma.$disconnect();
});

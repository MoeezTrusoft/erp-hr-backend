// F4 — A.Moiz (486) hire-date day/month swap: workbook "10/02/2026" is
// D/M/Y = 2026-02-10; the import parsed it US-style as 2026-10-02. HR's
// register pays him FULL August (25,000, zero deductions), confirming the
// true join date. Fix every downstream record in one transaction.
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

const OLD = new Date('2026-10-02T00:00:00.000Z');
const NEW = new Date('2026-02-10T00:00:00.000Z');

await mcpCtx.run({ system: true }, async () => {
  const e = await prisma.employee.findUnique({ where: { id: 486 }, select: { first_name: true, last_name: true, hire_date: true } });
  console.log('before:', e.first_name, e.last_name, 'hire:', e.hire_date?.toISOString());
  if (!e.hire_date || e.hire_date.getTime() !== OLD.getTime()) {
    console.log('hire_date is not 2026-10-02 — aborting (idempotence guard)');
  } else {
    // sequential guarded updates (interactive tx runs on a fresh connection
    // where the RLS bypass GUC is not set — outside-tx ops get it per-op)
    const eUp = await prisma.employee.updateMany({ where: { id: 486, hire_date: OLD }, data: { hire_date: NEW } });
    const t = await prisma.employmentTerms.updateMany({ where: { employeeId: 486, effectiveFrom: OLD }, data: { effectiveFrom: NEW } });
    const a = await prisma.payrollAssignment.updateMany({ where: { employeeId: 486, effectiveFrom: OLD }, data: { effectiveFrom: NEW } });
    const p = await prisma.employmentPeriod.updateMany({ where: { employeeId: 486, startDate: OLD }, data: { startDate: NEW } });
    const w = await prisma.workSchedule.updateMany({ where: { employeeId: 486, effective_start_date: OLD }, data: { effective_start_date: NEW } });
    console.log(`updated: employee=${eUp.count} terms=${t.count} assignments=${a.count} periods=${p.count} schedules=${w.count}`);
    const after = await prisma.employee.findUnique({ where: { id: 486 }, include: { employmentPeriods: true } });
    console.log('after: hire', after.hire_date?.toISOString()?.slice(0, 10), '| periods:', JSON.stringify(after.employmentPeriods.map((x) => ({ from: x.startDate?.toISOString()?.slice(0, 10), to: x.endDate?.toISOString()?.slice(0, 10) ?? 'open' }))));
  }

  // Kashif / Farhan august non-present rows (explain the 1-day engine charges)
  for (const id of [488, 497]) {
    const rows = await prisma.attendance.findMany({
      where: { employeeId: id, date: { gte: new Date('2026-08-01T00:00:00Z'), lte: new Date('2026-08-31T23:59:59Z') }, status: { notIn: ['PRESENT', 'WEEKLY_OFF', 'HOLIDAY', 'ON_LEAVE'] } },
      orderBy: { date: 'asc' },
      select: { date: true, status: true, check_in: true, remarks: true, day_credit: true },
    });
    console.log(`\n=== ${id} charged-class august rows ===`);
    for (const r of rows) console.log(r.date.toISOString().slice(0, 10), r.status, r.check_in?.toISOString() ?? '-', r.day_credit ?? '-', (r.remarks ?? '').slice(0, 45));
  }
});

await prisma.$disconnect();
process.exit(0);

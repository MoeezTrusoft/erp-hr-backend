// Phase 4 completion — mirror of the device writer for August, 4 tenants.
//
// The HR workbook only records punched days, HR text marks, off days and
// holidays; blank SCHEDULED WORKING days (the employee simply never showed)
// have no row, so absence recovery (D2) would pay them. This backfill:
//   1. backdates the 4 tenants' schedules from 2026-09-01 to 2026-08-01
//      (Meesam's re-hire schedule 2026-09-04 stays),
//   2. walks every employee × August day through the REAL resolveWorkingDays,
//   3. creates ONLY rows that don't exist: working→ABSENT, OFF_DAY→WEEKLY_OFF,
//      HOLIDAY→HOLIDAY.
// Imported punch rows and their LATE/PRESENT/HALF_DAY derivations are never
// touched. Employment scoping (N-16) keeps rows of non-employed staff inert.
import { mcpCtx } from '../src/mcp/context.js';
import { default as prisma } from '../src/lib/prisma.js';

const { resolveWorkingDays } = await import('../src/services/workingDay.service.js');

const TENANTS = [
  ['40314ef4-0a81-4390-b631-b3ad3f21f523', 'TRUSOFT'],
  ['8ff0533b-62f6-4be9-a78e-69adf49e00bc', 'HOMENET'],
  ['8f4a526f-d45b-4da2-b772-d6682e849812', 'JOC'],
  ['14d8c7b1-194d-4e35-b058-b9cb9aa9fba2', 'BOC'],
];
const FROM = '2026-08-01', TO = '2026-08-31';
const atMidnight = (s) => new Date(`${s}T00:00:00.000Z`);

await mcpCtx.run({ system: true }, async () => {
  // 1) backdate schedules (keep Meesam's Sep 4 re-hire row)
  const sched = await prisma.workSchedule.updateMany({
    where: {
      tenantId: { in: TENANTS.map((t) => t[0]) },
      effective_start_date: { gte: '2026-09-01T00:00:00.000Z', lt: '2026-09-04T00:00:00.000Z' },
    },
    data: { effective_start_date: '2026-08-01T00:00:00.000Z' },
  });
  console.log(`schedules backdated to Aug 1: ${sched.count}`);

  // 2) existing August rows, keyed by employeeId|date
  const existing = new Set();
  for (const [tenantId] of TENANTS) {
    const rows = await prisma.attendance.findMany({
      where: { tenantId, date: { gte: atMidnight(FROM), lte: atMidnight(TO) } },
      select: { employeeId: true, date: true },
    });
    for (const r of rows) existing.add(`${r.employeeId}|${r.date.toISOString().slice(0, 10)}`);
  }

  let created = { ABSENT: 0, WEEKLY_OFF: 0, HOLIDAY: 0 };
  for (const [tenantId, label] of TENANTS) {
    const employees = await prisma.employee.findMany({
      where: { tenant_id: tenantId },
      select: { id: true, first_name: true },
      orderBy: { id: 'asc' },
    });
    const toCreate = [];
    for (const emp of employees) {
      const days = await resolveWorkingDays({ employeeId: emp.id, from: atMidnight(FROM), to: atMidnight(TO) });
      for (const [key, info] of days) {
        if (existing.has(`${emp.id}|${key}`)) continue;
        if (info.reason === 'APPROVED_LEAVE') continue; // no August leaves; belt & braces
        const status = info.reason === 'HOLIDAY' ? 'HOLIDAY'
          : info.reason === 'OFF_DAY' || info.reason === 'ROTATION_OFF' ? 'WEEKLY_OFF'
          : 'ABSENT';
        toCreate.push({
          tenantId, employeeId: emp.id, date: new Date(`${key}T00:00:00.000Z`),
          status, day_credit: status === 'ABSENT' ? 0 : status === 'HALF_DAY' ? 0.5 : 1,
          remarks: 'AUGUST-BACKFILL',
        });
      }
    }
    if (toCreate.length) {
      const res = await prisma.attendance.createMany({ data: toCreate, skipDuplicates: true });
      for (const r of toCreate) created[r.status] = (created[r.status] ?? 0) + 1;
      console.log(`${label}: employees=${employees.length} created=${res.count}`);
    } else {
      console.log(`${label}: employees=${employees.length} created=0`);
    }
  }
  console.log('created by status:', JSON.stringify(created));
});

await prisma.$disconnect();
process.exit(0);

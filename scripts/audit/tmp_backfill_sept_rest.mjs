// Phase 5 — September 1–8(–9) pre-intake window, 4 tenants.
//
// The biometric writers for these tenants only started feeding on Sep 9–11
// (Homenet/JOC Sep 9, Trusoft Sep 10, BOC not at all yet), so the first days
// of September have no punch data. Marking those working days ABSENT would
// invent punishments for days we simply have no records for — so this
// backfill creates ONLY the schedule-derivable rest rows (WEEKLY_OFF /
// HOLIDAY), never ABSENT. Working days stay unmarked until HR supplies the
// Sep 1–8 records (same workbook flow as August).
import { mcpCtx } from '../src/mcp/context.js';
import { default as prisma } from '../src/lib/prisma.js';
import { resolveWorkingDays } from '../src/services/workingDay.service.js';

const TENANTS = [
  ['40314ef4-0a81-4390-b631-b3ad3f21f523', 'TRUSOFT', '2026-09-09'], // writer from Sep 10
  ['8ff0533b-62f6-4be9-a78e-69adf49e00bc', 'HOMENET', '2026-09-08'],
  ['8f4a526f-d45b-4da2-b772-d6682e849812', 'JOC', '2026-09-08'],
  ['14d8c7b1-194d-4e35-b058-b9cb9aa9fba2', 'BOC', '2026-09-08'],
];
const FROM = '2026-09-01';
const atMidnight = (s) => new Date(`${s}T00:00:00.000Z`);

await mcpCtx.run({ system: true }, async () => {
  let created = { WEEKLY_OFF: 0, HOLIDAY: 0 };
  for (const [tenantId, label, to] of TENANTS) {
    const existing = new Set();
    const rows = await prisma.attendance.findMany({
      where: { tenantId, date: { gte: atMidnight(FROM), lte: atMidnight(to) } },
      select: { employeeId: true, date: true },
    });
    for (const r of rows) existing.add(`${r.employeeId}|${r.date.toISOString().slice(0, 10)}`);

    const employees = await prisma.employee.findMany({ where: { tenant_id: tenantId }, select: { id: true } });
    const toCreate = [];
    for (const emp of employees) {
      const days = await resolveWorkingDays({ employeeId: emp.id, from: atMidnight(FROM), to: atMidnight(to) });
      for (const [key, info] of days) {
        if (existing.has(`${emp.id}|${key}`)) continue;
        if (info.reason !== 'OFF_DAY' && info.reason !== 'ROTATION_OFF' && info.reason !== 'HOLIDAY') continue;
        const status = info.reason === 'HOLIDAY' ? 'HOLIDAY' : 'WEEKLY_OFF';
        toCreate.push({
          tenantId, employeeId: emp.id, date: new Date(`${key}T00:00:00.000Z`),
          status, day_credit: 1, remarks: 'SEP-BACKFILL-REST',
        });
      }
    }
    if (toCreate.length) {
      const res = await prisma.attendance.createMany({ data: toCreate, skipDuplicates: true });
      for (const r of toCreate) created[r.status] = (created[r.status] ?? 0) + 1;
      console.log(`${label}: employees=${employees.length} restRowsCreated=${res.count}`);
    } else {
      console.log(`${label}: employees=${employees.length} restRowsCreated=0`);
    }
  }
  console.log('created by status:', JSON.stringify(created));
});

await prisma.$disconnect();
process.exit(0);

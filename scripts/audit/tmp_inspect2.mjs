// Inspection v2: biometric ids + raw punches for the six ruling targets,
// Shahzaib's anomaly rows (excused?), and current August row states.
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

const IDS = [480, 483, 488, 489, 493, 497];

await mcpCtx.run({ system: true }, async () => {
  const emps = await prisma.employee.findMany({
    where: { id: { in: IDS } },
    select: { id: true, first_name: true, last_name: true, biometric_id: true, employee_code: true },
  });
  for (const e of emps) console.log(`${e.id} ${e.first_name} ${e.last_name}: biometric=${e.biometric_id} code=${e.employee_code}`);

  // raw punches per employee for all of August (device PKT wall-clock)
  for (const e of emps) {
    const punches = await prisma.attendanceDevicePunch.findMany({
      where: { OR: [{ employeeId: e.id }, ...(e.biometric_id ? [{ deviceUserId: e.biometric_id }] : [])], punchedAt: { gte: new Date('2026-08-01T00:00:00Z'), lte: new Date('2026-08-31T23:59:59Z') } },
      orderBy: { punchedAt: 'asc' },
    }).catch(() => []);
    const ins = punches.filter((p) => p.status === 0).map((p) => p.punchedAt.toISOString().slice(5, 16));
    console.log(`\n${e.id} ${e.first_name}: ${punches.length} punches | IN punches: ${ins.join(' ')}`);
  }

  // anomaly rows for 483 Shahzaib + 493 Obaid + 489 Faique in August
  for (const id of [483, 493, 489, 480, 488, 497]) {
    const an = await prisma.attendanceAnomaly.findMany({
      where: { employeeId: id, date: { gte: new Date('2026-08-01T00:00:00Z'), lte: new Date('2026-08-31T23:59:59Z') } },
      orderBy: { date: 'asc' },
      select: { date: true, type: true, status: true, sourceKind: true, remarks: true },
    });
    const e = emps.find((x) => x.id === id);
    console.log(`\n=== ${id} ${e?.first_name} anomalies (${an.length}) ===`);
    for (const a of an) console.log(a.date?.toISOString()?.slice(0, 10), a.type, a.status, a.sourceKind ?? '', (a.remarks ?? '').slice(0, 40));
  }

  // current August non-present rows for the six
  for (const id of IDS) {
    const rows = await prisma.attendance.findMany({
      where: { employeeId: id, date: { gte: new Date('2026-08-01T00:00:00Z'), lte: new Date('2026-08-31T23:59:59Z') }, status: { in: ['LATE', 'HALF_DAY', 'ABSENT', 'MISSING_CHECKIN', 'MISSING_CHECKOUT'] } },
      orderBy: { date: 'asc' },
      select: { date: true, status: true, check_in: true, day_credit: true, remarks: true },
    });
    const e = emps.find((x) => x.id === id);
    console.log(`\n=== ${id} ${e?.first_name} charged rows ===`);
    for (const r of rows) console.log(r.date.toISOString().slice(0, 10), r.status, r.check_in?.toISOString()?.slice(11, 16) ?? '-', String(r.day_credit), (r.remarks ?? '').slice(0, 30));
  }
});

await prisma.$disconnect();
process.exit(0);

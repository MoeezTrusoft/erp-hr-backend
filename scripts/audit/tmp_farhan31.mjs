// Farhan (497) — full system record for Mon 2026-08-31: derived Attendance row
// plus any raw device punches (ground truth) for his biometric enrolments.
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

await mcpCtx.run({ system: true }, async () => {
  const rows = await prisma.attendance.findMany({
    where: { employeeId: 497, date: { gte: new Date('2026-08-31T00:00:00Z'), lte: new Date('2026-08-31T23:59:59Z') } },
    select: { date: true, status: true, check_in: true, check_out: true, day_credit: true, remarks: true, requires_regularization: true },
  });
  console.log('=== Attendance rows 2026-08-31 ===');
  for (const r of rows) console.log(JSON.stringify({ date: r.date?.toISOString(), status: r.status, check_in: r.check_in?.toISOString() ?? null, check_out: r.check_out?.toISOString() ?? null, day_credit: r.day_credit, remarks: r.remarks ?? null, requires_regularization: r.requires_regularization ?? null }));

  const emp = await prisma.employee.findUnique({ where: { id: 497 }, select: { biometric_id: true, employee_code: true } });
  console.log('biometric_id:', emp?.biometric_id, '| code:', emp?.employee_code);

  const punches = await prisma.attendanceDevicePunch.findMany({
    where: {
      OR: [
        { employeeId: 497 },
        ...(emp?.biometric_id ? [{ deviceUserId: emp.biometric_id }] : []),
        ...(emp?.employee_code ? [{ deviceUserId: emp.employee_code }] : []),
      ],
      punchedAt: { gte: new Date('2026-08-31T00:00:00Z'), lte: new Date('2026-09-01T23:59:59Z') },
    },
    orderBy: { punchedAt: 'asc' },
  }).catch(() => []);
  console.log(`=== raw device punches Aug 31–Sep 1 (${punches.length}) ===`);
  for (const p of punches) console.log(p.punchedAt?.toISOString(), p.deviceUserId ?? '', `status=${p.status}`);
});

await prisma.$disconnect();
process.exit(0);

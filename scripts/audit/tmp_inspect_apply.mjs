// Pre-application inspection: Kashif schedule+punches (Aug 18/19), Obaid shift,
// Farhan Aug 10/13 rows, Faique shift, Trusoft rule config.
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

await mcpCtx.run({ system: true }, async () => {
  // 1) schedules for 488 Kashif, 493 Obaid, 489 Faique, 497 Farhan
  for (const id of [488, 493, 489, 497]) {
    const ws = await prisma.workSchedule.findMany({ where: { employeeId: id }, orderBy: { effective_start_date: 'asc' } });
    const e = await prisma.employee.findUnique({ where: { id }, select: { first_name: true, last_name: true } });
    console.log(`=== ${id} ${e?.first_name} ${e?.last_name} schedules ===`);
    for (const w of ws) {
      const p = w.schedule_pattern ?? {};
      console.log(`from ${w.effective_start_date?.toISOString()?.slice(0, 10)} to ${w.effective_end_date?.toISOString()?.slice(0, 10) ?? 'open'} | shift=${JSON.stringify(p.shift ?? p.shiftByDay ?? p)} | off=${JSON.stringify(p.offDays ?? p.off_days ?? '?')}`);
    }
  }

  // 2) Kashif raw punches Aug 18-19
  const punches = await prisma.attendanceDevicePunch.findMany({
    where: { OR: [{ employeeId: 488 }, { deviceUserId: '3113' }], punchedAt: { gte: new Date('2026-08-18T00:00:00Z'), lte: new Date('2026-08-20T23:59:59Z') } },
    orderBy: { punchedAt: 'asc' },
  }).catch(() => []);
  console.log(`\n=== Kashif raw punches Aug 18-20 (${punches.length}) ===`);
  for (const p of punches) console.log(p.punchedAt?.toISOString(), p.deviceUserId, `status=${p.status}`);

  // 3) Farhan Aug 10/13 attendance rows
  const f = await prisma.attendance.findMany({
    where: { employeeId: 497, date: { gte: new Date('2026-08-10T00:00:00Z'), lte: new Date('2026-08-13T23:59:59Z') } },
    orderBy: { date: 'asc' },
    select: { date: true, status: true, check_in: true, check_out: true, day_credit: true, remarks: true },
  });
  console.log('\n=== Farhan Aug 10-13 rows ===');
  for (const r of f) console.log(r.date.toISOString().slice(0, 10), r.status, r.check_in?.toISOString() ?? '-', r.check_out?.toISOString() ?? '-', r.day_credit);

  // 4) Obaid Aug 19 + anomaly rows for the 5 target employees
  const ob = await prisma.attendance.findFirst({ where: { employeeId: 493, date: { gte: new Date('2026-08-19T00:00:00Z'), lte: new Date('2026-08-19T23:59:59Z') } }, select: { date: true, status: true, day_credit: true } });
  console.log('\nObaid Aug 19:', JSON.stringify(ob));

  // 5) Trusoft rule config
  const cfg = await prisma.payrollRuleConfig.findFirst({ where: { tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523' }, select: { id: true, deductionBasis: true, absenceRecoveryEnabled: true, status: true, version: true } });
  console.log('Trusoft ruleConfig:', JSON.stringify(cfg));
});

await prisma.$disconnect();
process.exit(0);

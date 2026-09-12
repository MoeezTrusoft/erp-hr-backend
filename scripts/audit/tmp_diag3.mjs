// Scan ALL tenants for future-dated or August-undefined employees (day/month
// swap class, like A.Moiz 486: hire 2026-10-02 vs true 2026-02-10), then finish
// the Shahzaib / Asad / half-day diagnostics.
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

const TEN = '40314ef4-0a81-4390-b631-b3ad3f21f523';

await mcpCtx.run({ system: true }, async () => {
  // ---- scan: any employee whose hire date or open term starts after Sep 2026
  const future = await prisma.employee.findMany({
    where: { hire_date: { gt: new Date('2026-09-01T00:00:00Z') } },
    select: { id: true, first_name: true, last_name: true, hire_date: true, tenant_id: true },
  });
  console.log('=== future-dated employees (swap suspects) ===');
  for (const e of future) console.log(e.id, `${e.first_name} ${e.last_name}`, 'hire:', e.hire_date?.toISOString()?.slice(0, 10), e.tenant_id?.slice(0, 8));

  // future-dated employment periods / terms
  const futPeriods = await prisma.employmentPeriod.findMany({
    where: { startDate: { gt: new Date('2026-09-01T00:00:00Z') } },
    select: { employeeId: true, startDate: true, endDate: true }
  });
  console.log('=== future-dated employment periods ===');
  for (const p of futPeriods) console.log('employeeId', p.employeeId, 'from', p.startDate?.toISOString()?.slice(0, 10), 'to', p.endDate?.toISOString()?.slice(0, 10) ?? 'open', p.endDate ? 'closed' : 'open');

  // also: open terms effective in the future
  const futTerms = await prisma.payrollAssignment.findMany({
    where: { effectiveFrom: { gt: new Date('2026-09-01T00:00:00Z') } },
    select: { employeeId: true, effectiveFrom: true, amount: true },
  });
  console.log('=== future-dated terms ===');
  for (const t of futTerms) console.log('employeeId', t.employeeId, 'from', t.effectiveFrom?.toISOString()?.slice(0, 10), 'amount', String(t.amount));

  // ---- 483 Shahzaib: august attendance rows
  const shah = await prisma.attendance.findMany({
    where: { employeeId: 483, date: { gte: new Date('2026-08-01T00:00:00Z'), lte: new Date('2026-08-31T23:59:59Z') }, status: { notIn: ['PRESENT', 'WEEKLY_OFF', 'HOLIDAY'] } },
    orderBy: { date: 'asc' },
    select: { date: true, status: true, check_in: true, remarks: true },
  });
  console.log('\n=== 483 Shahzaib non-working august rows ===');
  for (const r of shah) console.log(r.date.toISOString().slice(0, 10), r.status, r.check_in?.toISOString() ?? '-', (r.remarks ?? '').slice(0, 50));

  // ---- 482 Asad: terms + payslip lines
  const asad = await prisma.employee.findUnique({ where: { id: 482 }, include: { employmentTerms: true, payrollAssignments: true } });
  console.log('\n=== 482 Asad terms ===');
  console.log('terms:', JSON.stringify(asad.employmentTerms.map((t) => ({ salary: String(t.baseSalary), from: t.effectiveFrom?.toISOString()?.slice(0, 10), to: t.effectiveTo?.toISOString()?.slice(0, 10) ?? null }))));
  console.log('assignments:', JSON.stringify(asad.payrollAssignments?.map((a) => ({ amt: String(a.amount), from: a.effectiveFrom?.toISOString()?.slice(0, 10), to: a.effectiveTo?.toISOString()?.slice(0, 10) ?? null }))));
  const slip482 = await prisma.payrollPayslip.findFirst({ where: { tenantId: TEN, employeeId: 482, payrollRunId: 12 }, include: { earnings: true, deductions: true } });
  console.log('earnings:', JSON.stringify(slip482?.earnings.map((e) => ({ t: e.earningTypeId, a: String(e.amount), d: (e.description ?? '').slice(0, 50) }))));
  console.log('deductions:', JSON.stringify(slip482?.deductions.map((d) => ({ t: d.deductionTypeId, a: String(d.amount), d: (d.description ?? '').slice(0, 70) }))));

  // ---- half-day / late marks for pattern employees
  for (const id of [488, 489, 497, 493, 480]) {
    const rows = await prisma.attendance.findMany({
      where: { employeeId: id, date: { gte: new Date('2026-08-01T00:00:00Z'), lte: new Date('2026-08-31T23:59:59Z') }, status: { in: ['HALF_DAY', 'LATE'] } },
      orderBy: { date: 'asc' },
      select: { date: true, status: true, check_in: true, remarks: true },
    });
    const e = await prisma.employee.findUnique({ where: { id }, select: { first_name: true, last_name: true } });
    console.log(`\n=== ${id} ${e?.first_name} ${e?.last_name} HALF_DAY/LATE ===`);
    for (const r of rows) console.log(r.date.toISOString().slice(0, 10), r.status, r.check_in?.toISOString() ?? '-', (r.remarks ?? '').slice(0, 55));
  }
});

await prisma.$disconnect();
process.exit(0);

// Evidence pack for HR ruling 2026-09-13:
//  - Shah Hassan Jafry: dual-tenant (JOC + BOC) 70K split to 35K/35K, zero anomalies claimed
//  - Akash (JOC, 6 pooled days) and Akash (HomeVision, 2 pooled days): zero anomalies claimed
// Dumps terms, periods, assignments, schedules, attendance rows, anomalies, raw punches.
import { mcpCtx } from '../../src/mcp/context.js';
import prisma from '../../src/lib/prisma.js';

const JOC = '8f4a526f-d45b-4da2-b772-d6682e849812';
const BOC = '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2';
const HV = '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73';

const AUG0 = new Date('2026-08-01T00:00:00.000Z');
const SEP0 = new Date('2026-09-01T00:00:00.000Z');

async function findEmployee(tenantId, namePart) {
  const emps = await prisma.employee.findMany({
    where: {
      OR: [{ first_name: { contains: namePart } }, { last_name: { contains: namePart } }],
    },
    select: { id: true, first_name: true, last_name: true, biometric_id: true, employee_code: true },
  });
  // filter to those with a row in this tenant (attendance/terms/assignments/payslip)
  const out = [];
  for (const e of emps) {
    const [terms, slips] = await Promise.all([
      prisma.employmentTerms.count({ where: { tenantId, employeeId: e.id } }),
      prisma.payrollPayslip.count({ where: { tenantId, employeeId: e.id } }),
    ]);
    if (terms > 0 || slips > 0) out.push({ ...e, terms, slips });
  }
  return out;
}

function dumpEmp(label, tenantId, tenantName, emp) {
  console.log(`\n================ ${tenantName} :: ${label} ================`);
  console.log(`employee id=${emp.id} code=${emp.employee_code} bio=${emp.biometric_id} name=${emp.first_name} ${emp.last_name}`);
  return (async () => {
    const [terms, periods, assigns, scheds, att, anoms, punches, slip] = await Promise.all([
      prisma.employmentTerms.findMany({
        where: { tenantId, employeeId: emp.id },
        orderBy: { effectiveFrom: 'asc' },
        select: { id: true, baseSalary: true, currency: true, effectiveFrom: true, effectiveTo: true, payFrequency: true },
      }),
      prisma.employmentPeriod.findMany({
        where: { tenantId, employeeId: emp.id },
        select: { startDate: true, endDate: true, reason: true, note: true },
      }),
      prisma.payrollAssignment.findMany({
        where: { tenantId, employeeId: emp.id },
        select: { amount: true, earningType: { select: { code: true } }, deductionType: { select: { code: true } }, effectiveFrom: true, effectiveTo: true, isActive: true },
      }),
      prisma.workSchedule.findMany({
        where: { tenantId, employeeId: emp.id },
        select: { schedule_name: true, effective_start_date: true, effective_end_date: true, total_hours_per_week: true, schedule_pattern: true },
      }),
      prisma.attendance.findMany({
        where: { tenantId, employeeId: emp.id, date: { gte: AUG0, lt: SEP0 } },
        orderBy: { date: 'asc' },
        select: { date: true, status: true, day_credit: true, check_in: true, check_out: true, remarks: true, requires_regularization: true, manually_corrected: true },
      }),
      prisma.attendanceAnomaly.findMany({
        where: { employeeId: emp.id, OR: [{ date: { gte: AUG0, lt: SEP0 } }, { applicationDate: { gte: AUG0, lt: SEP0 } }] },
        select: { type: true, date: true, status: true, reason: true },
      }),
      prisma.attendanceDevicePunch.findMany({
        where: { OR: [{ employeeId: emp.id }, { deviceUserId: emp.biometric_id ?? '___none___' }], punchedAt: { gte: AUG0, lt: SEP0 } },
        orderBy: { punchedAt: 'asc' },
        select: { deviceUserId: true, punchedAt: true, status: true, employeeId: true, sn: true },
      }),
      prisma.payrollPayslip.findFirst({
        where: { tenantId, employeeId: emp.id, payrollRun: { periodStart: { gte: AUG0, lt: SEP0 } } },
        select: { grossAmount: true, netAmount: true, deductions: { select: { amount: true, description: true, deductionType: { select: { code: true } } } } },
      }),
    ]);
    console.log('TERMS:', JSON.stringify(terms));
    console.log('PERIODS:', JSON.stringify(periods));
    console.log('ASSIGNMENTS:', JSON.stringify(assigns.map(a => ({ earn: a.earningType?.code, ded: a.deductionType?.code, amount: String(a.amount), from: a.effectiveFrom, to: a.effectiveTo, active: a.isActive }))));
    for (const s of scheds) console.log('SCHEDULE:', s.schedule_name, s.effective_start_date, '->', s.effective_end_date, `${s.total_hours_per_week}h/wk`, JSON.stringify(s.schedule_pattern));
    console.log(`ATTENDANCE (${att.length} rows):`);
    for (const a of att) {
      const d = a.date instanceof Date ? a.date.toISOString().slice(0, 10) : a.date;
      const ci = a.check_in ? new Date(a.check_in).toISOString().slice(5, 16).replace('T', ' ') : '-';
      const co = a.check_out ? new Date(a.check_out).toISOString().slice(5, 16).replace('T', ' ') : '-';
      console.log(`  ${d} ${a.status} credit=${a.day_credit} in=${ci} out=${co}${a.manually_corrected ? ' [MANUAL]' : ''}${a.requires_regularization ? ' [REGZ]' : ''} ${a.remarks ?? ''}`);
    }
    console.log(`ANOMALIES (${anoms.length}):`);
    for (const x of anoms) console.log(`  ${x.date ? new Date(x.date).toISOString().slice(0, 10) : '?'} ${x.type} ${x.status} — ${(x.reason ?? '').slice(0, 80)}`);
    console.log(`RAW PUNCHES (${punches.length}):`);
    for (const p of punches) console.log(`  ${new Date(p.punchedAt).toISOString()} user=${p.deviceUserId} st=${p.status} sn=${p.sn}`);
    if (slip) {
      console.log(`PAYSLIP: gross=${slip.grossAmount} net=${slip.netAmount}`);
      for (const d of slip.deductions) console.log(`   - ${d.deductionType?.code}: ${d.description} = ${d.amount}`);
    }
  })();
}

await mcpCtx.run({ system: true }, async () => {
  // locate both Akash variants and Shah Hassan in each tenant
  for (const [tenantId, tenantName, namePart] of [[JOC, 'JOC', 'Shah Hassan'], [BOC, 'BOC', 'Shah Hassan'], [JOC, 'JOC', 'Akash'], [HV, 'HOMEVISION', 'Akash']]) {
    const found = await findEmployee(tenantId, namePart);
    console.log(`\n#### tenant=${tenantName} search="${namePart}" -> ${found.length} match(es): ${found.map(f => `id=${f.id} ${f.first_name} ${f.last_name} bio=${f.biometric_id} terms=${f.terms} slips=${f.slips}`).join(' | ')}`);
    for (const e of found) await dumpEmp(namePart, tenantId, tenantName, e);
  }
});
await prisma.$disconnect();
process.exit(0);

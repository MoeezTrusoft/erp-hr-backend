import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';
const TRUSOFT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const RUN = 16;
await mcpCtx.run({ system: true }, async () => {
  const slips = await prisma.payrollPayslip.findMany({
    where: { tenantId: TRUSOFT, payrollRunId: RUN },
    include: {
      employee: { select: { id: true, first_name: true, last_name: true } },
      deductions: { include: { deductionType: true } },
    },
    orderBy: { employeeId: 'asc' },
  });
  console.log('TRUSOFT Run 16 — ' + slips.length + ' payslips');
  for (const s of slips) {
    const name = (s.employee.first_name + ' ' + s.employee.last_name).trim();
    const deds = s.deductions.map(d => ({ type: d.deductionType?.name ?? '?', desc: d.description ?? '', amount: d.amount }));
    const attDeds = deds.filter(d => /attendance/i.test(d.type) || /attendance/i.test(d.desc));
    const loanDeds = deds.filter(d => /loan|advance/i.test(d.type) || /loan|advance/i.test(d.desc));
    const taxDeds = deds.filter(d => /tax/i.test(d.type));
    const gross = Number(s.grossAmount);
    const dailyRate = gross / 31;
    const attAmt = attDeds.reduce((t, d) => t + Number(d.amount), 0);
    console.log(name + ' | id=' + s.employee.id + ' | gross=' + gross.toFixed(2) + ' | net=' + Number(s.netAmount).toFixed(2) + ' | attDed=' + attAmt.toFixed(2) + ' | loan=' + loanDeds.reduce((t,d) => t + Number(d.amount), 0).toFixed(2) + ' | tax=' + taxDeds.reduce((t,d) => t + Number(d.amount), 0).toFixed(2));
    if (attDeds.length) {
      for (const d of attDeds) console.log('  ATT: ' + d.type + ' | ' + d.desc + ' | ' + Number(d.amount).toFixed(2));
    }
    if (loanDeds.length) {
      for (const d of loanDeds) console.log('  LOAN: ' + d.type + ' | ' + d.desc + ' | ' + Number(d.amount).toFixed(2));
    }
    if (taxDeds.length) {
      for (const d of taxDeds) console.log('  TAX: ' + d.type + ' | ' + d.desc + ' | ' + Number(d.amount).toFixed(2));
    }
  }
});
await prisma.$disconnect();

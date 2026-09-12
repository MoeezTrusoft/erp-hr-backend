import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';
const TRUSOFT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const RUN = 12;  // Trusoft's actual run
await mcpCtx.run({ system: true }, async () => {
  const slips = await prisma.payrollPayslip.findMany({
    where: { tenantId: TRUSOFT, payrollRunId: RUN },
    include: {
      employee: { select: { id: true, first_name: true, last_name: true } },
      deductions: { include: { deductionType: true } },
    },
    orderBy: { employeeId: 'asc' },
  });
  console.log('TRUSOFT Run ' + RUN + ' — ' + slips.length + ' payslips\n');
  const hrN = { 'Syed Qasim Abbas': 0, 'Kashif Ali': 1, 'M. Farhan': 1, 'Obaid Afroz': 2, 'Faiq': 2, 'Muhammad Meesam': 2, 'Muhammad Shahzaib': 0 };
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
    const hrn = hrN[name];
    if (hrn !== undefined) {
      const expectedFromDays = (hrn * dailyRate).toFixed(2);
      console.log('  >>> HR-N=' + hrn + ' days => expected deduction ' + expectedFromDays + ' | actual attendance deduction ' + attAmt.toFixed(2) + ' | DIFF ' + (Number(expectedFromDays) - attAmt).toFixed(2));
    }
  }
});
await prisma.$disconnect();

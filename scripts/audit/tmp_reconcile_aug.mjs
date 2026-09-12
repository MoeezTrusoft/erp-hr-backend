// Phase 6.3 — August reconciliation export: one row per employee per run with
// the components HR's register compares: gross, attendance-deduction days and
// amount, loan recovery, income tax, net. Written to /tmp/aug_reconciliation.csv.
import { writeFileSync } from 'node:fs';
import { mcpCtx } from '../src/mcp/context.js';
import prisma from '../src/lib/prisma.js';

const RUNS = [
  [12, 'TRUSOFT', '40314ef4-0a81-4390-b631-b3ad3f21f523'],
  [13, 'HOMENET', '8ff0533b-62f6-4be9-a78e-69adf49e00bc'],
  [14, 'HOMEVISION', '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73'],
  [15, 'JOC', '8f4a526f-d45b-4da2-b772-d6682e849812'],
  [16, 'BOC', '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2'],
];

const rows = [['tenant', 'employee_id', 'name', 'code', 'gross', 'attendance_days', 'attendance_amount', 'loan_amount', 'tax_amount', 'total_deductions', 'net']];

await mcpCtx.run({ system: true }, async () => {
  for (const [runId, label, tenantId] of RUNS) {
    const slips = await prisma.payrollPayslip.findMany({
      where: { tenantId, payrollRunId: runId },
      include: {
        employee: { select: { id: true, first_name: true, last_name: true, employee_code: true } },
        earnings: { include: { earningType: true } },
        deductions: { include: { deductionType: true } },
      },
      orderBy: { employeeId: 'asc' },
    });
    for (const s of slips) {
      const attLines = s.deductions.filter((d) => /attendance/i.test(d.deductionType?.name ?? '') || /attendance/i.test(d.description ?? ''));
      const loanLines = s.deductions.filter((d) => /loan|advance/i.test(d.deductionType?.name ?? '') || /loan|advance/i.test(d.description ?? ''));
      const taxLines = s.deductions.filter((d) => /tax/i.test(d.deductionType?.name ?? ''));
      let attDays = '';
      for (const d of attLines) {
        const m = /(\d+(?:\.\d+)?)\s+days/.exec(d.description ?? '');
        if (m) attDays = m[1];
      }
      const sum = (arr) => arr.reduce((t, d) => t + Number(d.amount), 0).toFixed(2);
      rows.push([
        label, s.employee.id,
        `${s.employee.first_name ?? ''} ${s.employee.last_name ?? ''}`.trim(),
        s.employee.employee_code ?? '',
        Number(s.grossAmount).toFixed(2),
        attDays, sum(attLines), sum(loanLines), sum(taxLines),
        Number(s.totalDeductions).toFixed(2), Number(s.netAmount).toFixed(2),
      ].join(','));
    }
  }
});
writeFileSync('/tmp/aug_reconciliation.csv', rows.join('\n') + '\n');
console.log(`wrote /tmp/aug_reconciliation.csv (${rows.length - 1} employee rows)`);
process.exit(0);

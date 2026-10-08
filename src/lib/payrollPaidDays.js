import * as money from './money.js';

const DAY_DEDUCTIONS = new Set([
  'LWP_RECOVERY', 'ABSENCE_RECOVERY', 'ATTENDANCE_DEDUCTION',
  'MANAGEMENT_ATTENDANCE_DEDUCTION',
]);

// Read the day quantity recorded by the payroll engine, never divide rounded
// currency amounts by a daily rate or count taxes/loans as unpaid attendance.
function deductedDays(line) {
  const code = line.code ?? line.deductionType?.code;
  if (!DAY_DEDUCTIONS.has(code)) return 0;
  const matches = [...String(line.description ?? '').matchAll(/(\d+(?:\.\d+)?)\s+day(?:\(s\)|s)?\b/gi)];
  if (matches.length !== 1) return null;
  return Number(matches[0][1]);
}

export function calculatePayrollPaidDays({payrollRun, prorationFactor, deductions = []}) {
  if (prorationFactor == null) return null;
  const factor = Number(prorationFactor);
  if (!Number.isFinite(factor) || factor < 0 || factor > 1) return null;
  const utcDay = value => {
    const d = new Date(value);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const periodDays = (utcDay(payrollRun.periodEnd) - utcDay(payrollRun.periodStart)) / 86400000 + 1;
  if (!Number.isFinite(periodDays) || periodDays <= 0) return null;
  let unpaidDays = 0;
  for (const line of deductions) {
    const days = deductedDays(line);
    if (days == null) return null;
    unpaidDays += days;
  }
  // The engine stores proration at 1e-6; round only the final day quantity.
  return Math.round(Math.max(0, Math.min(periodDays, periodDays * factor - unpaidDays)) * 100) / 100;
}

export function resolvePayrollPaidDays({payrollRun, payslip, audit}) {
  if (payslip.payableDays != null) return Number(payslip.payableDays);
  if (!audit?.newValues || audit.payslipId !== payslip.id) return null;
  const currency = payrollRun.currencyCode || 'PKR';
  // A previous processing record must not explain a subsequently edited slip.
  for (const key of ['grossAmount', 'totalDeductions', 'netAmount']) {
    if (audit.newValues[key] == null || payslip[key] == null) return null;
    if (money.decimalToMinor(String(audit.newValues[key]), currency) !==
        money.decimalToMinor(String(payslip[key]), currency)) return null;
  }
  return calculatePayrollPaidDays({payrollRun, prorationFactor:audit.newValues.prorationFactor, deductions:payslip.deductions});
}

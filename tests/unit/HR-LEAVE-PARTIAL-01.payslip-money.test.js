// HR-LEAVE-PARTIAL-01 — what Management's per-day decision costs on the payslip. Unpaid leave (LWP) is paid for by the
// approved days only: a day Management rejected is not leave at all (it is an ordinary absence, priced by the
// attendance rules), and a day never asked for in a request with gaps is not leave either. 260,000 over the 31
// calendar days of October = 8,387 a day (whole rupees).
import { describe, it, expect } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';
import { approvedLeaveDays, unpaidLeaveDaysByEmployee } from '../../src/lib/approvedLeaveDays.js';
import { approvedLeaveCoverage } from '../../src/lib/approvedLeaveCoverage.js';

const d = (s) => new Date(`${s}T00:00:00.000Z`);
const run = { periodStart: d('2026-10-01'), periodEnd: d('2026-10-31'), currencyCode: 'PKR', countryCode: 'PK' };
const term = { baseSalary: '260000', payFrequency: 'MONTHLY', currency: 'PKR' };

const readDays = async (decisions) => {
  const db = { leaveRequest: { findMany: async () => [{ id: 1, employeeId: 1, startDate: d('2026-10-20'), endDate: d('2026-10-23'), totalDays: 4, leavePolicy: { leaveTypeCode: 'UNPAID' }, days: decisions.map(([date, decision]) => ({ date: d(date), decision })) }] } };
  return approvedLeaveDays(db, { tenantId: 't', from: run.periodStart, to: run.periodEnd });
};
const slipFor = async (decisions) => {
  const rows = await readDays(decisions);
  const lwpDays = unpaidLeaveDaysByEmployee(rows).get(1) ?? 0;
  const slip = buildPayslipFromInputs({ employee: { id: 1 }, employmentTerm: term, assignments: [], payrollRun: run, taxRateRows: [], bridges: { lwpDays } });
  return { lwpDays, covered: approvedLeaveCoverage(rows, run.periodStart, run.periodEnd).map((c) => c.date.toISOString().slice(0, 10)), slip };
};
const lwpLine = (slip) => slip.deductions.find((x) => /LWP|UNPAID/i.test(x.code));

describe('payslip money for a partly approved unpaid-leave request', () => {
  it('all four days approved: four days are unpaid', async () => {
    const { lwpDays, slip } = await slipFor([['2026-10-20', 'APPROVED'], ['2026-10-21', 'APPROVED'], ['2026-10-22', 'APPROVED'], ['2026-10-23', 'APPROVED']]);
    expect(lwpDays).toBe(4);
    expect(lwpLine(slip).amount).toBe('33548.0000');
  });
  it('one day rejected: three days are unpaid and the rejected day is not excused', async () => {
    const { lwpDays, covered, slip } = await slipFor([['2026-10-20', 'APPROVED'], ['2026-10-21', 'APPROVED'], ['2026-10-22', 'APPROVED'], ['2026-10-23', 'REJECTED']]);
    expect(lwpDays).toBe(3);
    expect(lwpLine(slip).amount).toBe('25161.0000');
    expect(covered).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });
  it('days picked with gaps (20 and 23): two days are unpaid, 21 and 22 are not leave', async () => {
    const { lwpDays, covered, slip } = await slipFor([['2026-10-20', 'APPROVED'], ['2026-10-23', 'APPROVED']]);
    expect(lwpDays).toBe(2);
    expect(lwpLine(slip).amount).toBe('16774.0000');
    expect(covered).toEqual(['2026-10-20', '2026-10-23']);
  });
  it('every day rejected: no unpaid leave', async () => {
    const { lwpDays, slip } = await slipFor([['2026-10-20', 'REJECTED'], ['2026-10-23', 'REJECTED']]);
    expect(lwpDays).toBe(0);
    expect(lwpLine(slip)).toBeUndefined();
  });
});

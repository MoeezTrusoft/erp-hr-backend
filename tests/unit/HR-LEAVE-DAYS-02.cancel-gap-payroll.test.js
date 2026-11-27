// HR-LEAVE-DAYS-02 — cancelling approved leave checks payroll against the days the
// leave actually holds. A request picked as 1-3 and 12-14 is not blocked by a
// run that covers only the 4th-11th gap.
import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../../src/services/approval/legacy.js', () => ({ legacySubmit: jest.fn() }));
const { assertNoPayrollRunOnLeave } = await import('../../src/services/leaveChangeRequest.service.js');

const d = (s) => new Date(`${s}T00:00:00.000Z`);
const leave = { id: 7, startDate: d('2026-12-01'), endDate: d('2026-12-14') };
const txWith = ({ days, runs }) => ({
  leaveRequestDay: { findMany: jest.fn(async () => days.map((x) => ({ date: d(x) }))) },
  payrollRun: {
    findMany: jest.fn(async () => runs.map(([a, b]) => ({ periodStart: d(a), periodEnd: d(b) }))),
    findFirst: jest.fn(async () => (runs.length ? { id: 1 } : null)),
  },
});
const picked = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-12', '2026-12-13', '2026-12-14'];

describe('cancel approved leave vs payroll runs', () => {
  it('a run covering only the gap does not block', async () => {
    await expect(assertNoPayrollRunOnLeave(txWith({ days: picked, runs: [['2026-12-04', '2026-12-11']] }), 't', leave)).resolves.toBeUndefined();
  });
  it('a run covering a held day still blocks', async () => {
    await expect(assertNoPayrollRunOnLeave(txWith({ days: picked, runs: [['2026-12-10', '2026-12-12']] }), 't', leave)).rejects.toMatchObject({ status: 409 });
  });
  it('leave without day rows keeps the whole-range check', async () => {
    const tx = txWith({ days: [], runs: [['2026-12-04', '2026-12-11']] });
    await expect(assertNoPayrollRunOnLeave(tx, 't', leave)).rejects.toMatchObject({ status: 409 });
    expect(tx.payrollRun.findFirst).toHaveBeenCalled();
  });
});

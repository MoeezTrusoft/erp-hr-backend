// HR-LEAVE-OVERVIEW-01 — pins the month-overview query behind the Leave
// Management widgets (Leaves by Department + Leaves Heatmap).
//
// The defect this guards: the prisma `select` on leave requests omitted
// `totalDays`. `r.totalDays` was therefore undefined on every row, so both the
// per-type and the per-department day counters summed `undefined` and every
// department reported 0 leave days — the bars rendered empty however much
// leave the month held. Prisma returns ONLY the selected scalar columns, so
// the omission was silent: no error, just wrong numbers.
//
// The assertion is on the SELECT SHAPE, not on rendered output: that is the
// only place the bug can reappear, and it is what a mocked read can prove
// without a live database.
import { describe, expect, it, jest } from '@jest/globals';

const findMany = jest.fn(async () => []);
const employeeFindMany = jest.fn(async () => []);

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    leaveRequest: { findMany },
    employee: { findMany: employeeFindMany },
  },
}));

const leaveManagement = await import('../../src/services/leaveManagement.service.js');
const { getLeaveMonthOverview } = leaveManagement;

describe('HR-LEAVE-OVERVIEW-01 · getLeaveMonthOverview', () => {
  it('selects totalDays, so per-department and per-type day counts are real', async () => {
    findMany.mockClear();
    employeeFindMany.mockClear();

    await getLeaveMonthOverview({ month: '2026-10' });

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    // The whole point: without this key every `r.totalDays` is undefined and
    // both counters read 0.
    expect(Object.keys(args.select)).toContain('totalDays');
    // The window fields the heatmap and the calendar depend on must survive.
    expect(Object.keys(args.select)).toEqual(
      expect.arrayContaining(['startDate', 'endDate', 'status', 'employeeId']),
    );
  });

  it('rejects a month that is not YYYY-MM', async () => {
    await expect(getLeaveMonthOverview({ month: 'October 2026' })).rejects.toThrow(
      /month must be YYYY-MM/,
    );
  });
});

describe('daysInWindow', () => {
  const { daysInWindow } = leaveManagement;
  const oct = [new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T23:59:59Z')];
  const sep = [new Date('2026-09-01T00:00:00Z'), new Date('2026-09-30T23:59:59Z')];
  it('keeps a request inside the month whole', () => {
    expect(daysInWindow({ startDate: '2026-10-05', endDate: '2026-10-07', totalDays: 3 }, ...oct)).toBe(3);
  });
  it('splits a request across two months instead of counting it twice', () => {
    const r = { startDate: '2026-09-16', endDate: '2026-10-16', totalDays: 31 };
    const a = daysInWindow(r, ...sep);
    const b = daysInWindow(r, ...oct);
    expect(Math.round((a + b) * 100) / 100).toBe(31);
    expect(a).toBeGreaterThan(14);
    expect(a).toBeLessThan(16);
  });
  it('is zero outside the window', () => {
    expect(daysInWindow({ startDate: '2026-11-02', endDate: '2026-11-03', totalDays: 2 }, ...oct)).toBe(0);
  });
});

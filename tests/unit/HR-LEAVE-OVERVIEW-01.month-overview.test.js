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

const { getLeaveMonthOverview } = await import(
  '../../src/services/leaveManagement.service.js'
);

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

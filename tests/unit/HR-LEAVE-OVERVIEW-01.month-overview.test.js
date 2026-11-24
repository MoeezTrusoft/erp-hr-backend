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
const { getLeaveMonthOverview, getNext30Coverage } = leaveManagement;

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

  it('month overview heatmap omits rejected days', async () => {
    const d = (n) => new Date(`2026-10-${n}T00:00:00.000Z`);
    findMany.mockResolvedValueOnce([
      {
        id: 31, employeeId: 7, leavePolicyId: 2, startDate: d('20'), endDate: d('24'), status: 'APPROVED', totalDays: 4,
        reason: null, employee: { id: 7, employee_code: 'E7' }, leavePolicy: { id: 2, name: 'Annual', leaveTypeCode: 'ANNUAL' },
        days: ['20', '21', '22', '23', '24'].map((n) => ({ date: d(n), decision: n === '23' ? 'REJECTED' : 'APPROVED' })),
      },
    ]);
    const out = await getLeaveMonthOverview({ month: '2026-10' });
    expect(findMany.mock.calls.at(-1)[0].select).toHaveProperty('days');
    const cell = (n) => out.days.find((c) => c.date === `2026-10-${n}`);
    expect(cell('22')).toMatchObject({ approved: 1, disapproved: 0 });
    expect(cell('23')).toMatchObject({ approved: 0, disapproved: 1 });
    expect(cell('23').leaves).toEqual([expect.objectContaining({ id: 31, status: 'REJECTED' })]);
    expect(cell('24')).toMatchObject({ approved: 1, disapproved: 0 });
    expect(out.byType.annual).toBe(4);
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
  it('counts only the APPROVED day rows of a partly approved request', () => {
    const days = ['09-29', '09-30', '10-01', '10-02'].map((s) => ({ date: `2026-${s}`, decision: s === '10-01' ? 'REJECTED' : 'APPROVED' }));
    const r = { status: 'APPROVED', startDate: '2026-09-29', endDate: '2026-10-02', totalDays: 3, days };
    expect(daysInWindow(r, ...sep)).toBe(2);
    expect(daysInWindow(r, ...oct)).toBe(1);
  });
  it('is zero outside the window', () => {
    expect(daysInWindow({ startDate: '2026-11-02', endDate: '2026-11-03', totalDays: 2 }, ...oct)).toBe(0);
  });
});

describe('getNext30Coverage (HR-LEAVE-PARTIAL-01)', () => {
  it('counts approved leave days per day and per department; a rejected day is not on leave', async () => {
    // Same "today" the service uses (local midnight); dates are keyed by ISO date like its daily output.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const at = (n) => new Date(today.getTime() + n * 86400000);
    const key = (n) => at(n).toISOString().slice(0, 10);
    employeeFindMany.mockResolvedValueOnce([
      { id: 7, businessUnitId: 1, businessUnit: { id: 1, name: 'Ops' } },
      { id: 8, businessUnitId: 1, businessUnit: { id: 1, name: 'Ops' } },
      { id: 9, businessUnitId: 2, businessUnit: { id: 2, name: 'Sales' } },
    ]);
    // Employee 7: approved leave days +1..+3, Management rejected +2. Employee 9: legacy request +2..+2 (no day rows).
    findMany.mockResolvedValueOnce([
      {
        id: 31, employeeId: 7, startDate: at(1), endDate: at(3), totalDays: 2, leavePolicy: { leaveTypeCode: 'ANNUAL' },
        days: [1, 2, 3].map((n) => ({ date: at(n), decision: n === 2 ? 'REJECTED' : 'APPROVED' })),
      },
      { id: 32, employeeId: 9, startDate: at(2), endDate: at(2), totalDays: 1, leavePolicy: { leaveTypeCode: 'ANNUAL' }, days: [] },
    ]);
    const out = await getNext30Coverage({}, 'tenant-a');
    const day = (n) => out.daily.find((d) => d.date === key(n));
    expect(day(0).onLeave).toBe(0);
    expect(day(1).onLeave).toBe(1);
    expect(day(2).onLeave).toBe(1); // only employee 9: employee 7's rejected day is not leave
    expect(day(3).onLeave).toBe(1);
    expect(out.totalEmployees).toBe(3);
    expect(out.departments).toEqual([
      { department: 'Ops', totalEmployees: 2, presentEmployees: 1, onLeave: 1, presentPct: 50 },
      { department: 'Sales', totalEmployees: 1, presentEmployees: 0, onLeave: 1, presentPct: 0 },
    ]);
  });
});

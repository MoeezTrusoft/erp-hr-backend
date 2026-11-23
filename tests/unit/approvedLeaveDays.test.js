import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const db = { leaveRequest: { findMany: jest.fn() } };
const listWorkingDates = jest.fn();
jest.unstable_mockModule('../../src/services/leave.service.js', () => ({ listWorkingDates }));
const { approvedLeaveDays, unpaidLeaveDaysByEmployee } = await import('../../src/lib/approvedLeaveDays.js');

const d = (s) => new Date(`${s}T00:00:00.000Z`);
const day = (s, decision) => ({ date: d(s), decision });
const req = (over) => ({ id: 1, employeeId: 7, startDate: d('2026-10-20'), endDate: d('2026-10-24'), leavePolicy: { leaveTypeCode: 'ANNUAL' }, days: [], ...over });
const period = { tenantId: 'tenant-a', from: d('2026-10-01'), to: d('2026-10-31') };

beforeEach(() => { jest.resetAllMocks(); });

describe('approvedLeaveDays', () => {
  it('uses APPROVED day rows and skips REJECTED ones', async () => {
    db.leaveRequest.findMany.mockResolvedValue([req({ days: [day('2026-10-20', 'APPROVED'), day('2026-10-21', 'APPROVED'), day('2026-10-22', 'APPROVED'), day('2026-10-23', 'REJECTED'), day('2026-10-24', 'PENDING')] })]);
    const rows = await approvedLeaveDays(db, period);
    expect(rows.map((r) => r.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
    expect(rows[0]).toEqual({ employeeId: 7, date: '2026-10-20', leaveRequestId: 1, leaveTypeCode: 'ANNUAL', weight: 1 });
    expect(listWorkingDates).not.toHaveBeenCalled();
  });
  it('falls back to every calendar date, weighted totalDays/span, for a legacy request without rows', async () => {
    db.leaveRequest.findMany.mockResolvedValue([req({ leavePolicy: null, startDate: d('2026-10-19'), endDate: d('2026-10-25'), totalDays: 6 })]);
    const rows = await approvedLeaveDays(db, period);
    expect(rows.map((r) => r.date)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    expect(rows[0]).toMatchObject({ employeeId: 7, leaveRequestId: 1, leaveTypeCode: null });
    expect(rows.reduce((n, r) => n + r.weight, 0)).toBeCloseTo(6);
  });
  it('never asks for working dates, so missing attendance setup cannot abort it', async () => {
    db.leaveRequest.findMany.mockResolvedValue([req({ totalDays: 5 })]);
    await expect(approvedLeaveDays(db, period)).resolves.toHaveLength(5);
    expect(listWorkingDates).not.toHaveBeenCalled();
  });
  it('clips a cross-month request to the period', async () => {
    db.leaveRequest.findMany.mockResolvedValue([req({ startDate: d('2026-10-30'), endDate: d('2026-11-02'), days: ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map((s) => day(s, 'APPROVED')) })]);
    const rows = await approvedLeaveDays(db, period);
    expect(rows.map((r) => r.date)).toEqual(['2026-10-30', '2026-10-31']);
  });
  it('clips a legacy cross-month request: payroll formula totalDays*overlap/span', async () => {
    db.leaveRequest.findMany.mockResolvedValue([req({ startDate: d('2026-10-30'), endDate: d('2026-11-02'), totalDays: 3, leavePolicy: { leaveTypeCode: 'UNPAID' } })]);
    const rows = await approvedLeaveDays(db, period);
    expect(rows.map((r) => [r.date, r.weight])).toEqual([['2026-10-30', 0.75], ['2026-10-31', 0.75]]);
    expect(unpaidLeaveDaysByEmployee(rows).get(7)).toBeCloseTo(1.5);
  });
  it('scopes the query to the tenant, APPROVED status, overlap and employees', async () => {
    db.leaveRequest.findMany.mockResolvedValue([]);
    await approvedLeaveDays(db, { ...period, employeeIds: [7, 8] });
    expect(db.leaveRequest.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 'tenant-a', status: 'APPROVED', startDate: { lte: period.to }, endDate: { gte: period.from }, employeeId: { in: [7, 8] },
    });
  });
});

describe('unpaidLeaveDaysByEmployee', () => {
  it('counts only UNPAID and LWP', () => {
    const rows = [
      { employeeId: 7, leaveTypeCode: 'UNPAID', weight: 1 }, { employeeId: 7, leaveTypeCode: 'LWP', weight: 1 }, { employeeId: 7, leaveTypeCode: 'ANNUAL', weight: 1 },
      { employeeId: 8, leaveTypeCode: 'ANNUAL', weight: 1 }, { employeeId: 9, leaveTypeCode: 'UNPAID', weight: 1 }, { employeeId: 9, leaveTypeCode: null, weight: 1 },
    ];
    expect(unpaidLeaveDaysByEmployee(rows)).toEqual(new Map([[7, 2], [9, 1]]));
    expect(unpaidLeaveDaysByEmployee([{ employeeId: 7, leaveTypeCode: 'LWP', weight: 0.5 }, { employeeId: 7, leaveTypeCode: 'UNPAID', weight: 0.25 }]).get(7)).toBeCloseTo(0.75);
  });
});

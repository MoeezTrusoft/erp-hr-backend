// HR-ATT-ONCALL-02 — a call-in is an attendance-changing write: it respects the
// payroll lock and re-queues an already evaluated day, on create AND on cancel.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const tx = {
  employee: { findFirst: jest.fn() },
  attendanceCallIn: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  attendanceEvaluationJob: { updateMany: jest.fn() },
};
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: jest.fn(async (_db, fn) => fn(tx)),
  rlsTenantExtension: (client) => client,
  isTenantTransaction: () => false,
}));
jest.unstable_mockModule('../../src/services/attendancePeriod.service.js', () => ({
  assertAttendancePeriodOpen: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../src/services/attendanceFinalization.service.js', () => ({
  enqueueEvaluationRange: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../src/lib/holidayDates.js', () => ({
  todayInZone: () => new Date('2026-11-24T00:00:00.000Z'),
}));

const svc = await import('../../src/services/attendanceOnCall.service.js');
const period = await import('../../src/services/attendancePeriod.service.js');
const fin = await import('../../src/services/attendanceFinalization.service.js');

const T = 'tenant-A';
beforeEach(() => {
  jest.clearAllMocks();
  tx.employee.findFirst.mockResolvedValue({ id: 4, employee_code: 'EMP-4' });
  tx.attendanceCallIn.findFirst.mockResolvedValue(null);
  tx.attendanceCallIn.create.mockImplementation(async ({ data }) => ({ id: 9, ...data }));
});

describe('recording a call-in', () => {
  it('re-queues a day already evaluated (marked after the weekend)', async () => {
    const r = await svc.createCallIn({ employeeId: 4, date: '2026-11-22', tenantId: T, calledBy: '17' });
    expect(r.reevaluated).toBe(true);
    expect(fin.enqueueEvaluationRange).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T, employeeIds: [4] }), tx);
    expect(tx.attendanceCallIn.create.mock.calls[0][0].data).toMatchObject({ tenantId: T, calledBy: '17' });
  });
  it('leaves a future day to the daily planner', async () => {
    const r = await svc.createCallIn({ employeeId: 4, date: '2026-11-28', tenantId: T });
    expect(r.reevaluated).toBe(false);
    expect(fin.enqueueEvaluationRange).not.toHaveBeenCalled();
  });
  it('is refused inside a payroll period, before anything is written', async () => {
    period.assertAttendancePeriodOpen.mockRejectedValueOnce(Object.assign(new Error('PERIOD_PROTECTED'), { status: 409 }));
    await expect(svc.createCallIn({ employeeId: 4, date: '2026-11-22', tenantId: T })).rejects.toMatchObject({ status: 409 });
    expect(tx.attendanceCallIn.create).not.toHaveBeenCalled();
  });
  it('needs a tenant', async () => {
    await expect(svc.createCallIn({ employeeId: 4, date: '2026-11-22' })).rejects.toMatchObject({ status: 401 });
  });
});

describe('cancelling a call-in', () => {
  it('re-queues the day so a no-show ABSENT goes back to an off day', async () => {
    tx.attendanceCallIn.findFirst.mockResolvedValue({ id: 9, employeeId: 4, date: new Date('2026-11-22T00:00:00Z') });
    const r = await svc.removeCallIn({ id: 9, tenantId: T });
    expect(r).toMatchObject({ deleted: true, reevaluated: true });
    expect(tx.attendanceCallIn.delete).toHaveBeenCalledWith({ where: { id: 9 } });
    expect(fin.enqueueEvaluationRange).toHaveBeenCalled();
  });
  it('is refused inside a payroll period', async () => {
    tx.attendanceCallIn.findFirst.mockResolvedValue({ id: 9, employeeId: 4, date: new Date('2026-11-22T00:00:00Z') });
    period.assertAttendancePeriodOpen.mockRejectedValueOnce(Object.assign(new Error('PERIOD_PROTECTED'), { status: 409 }));
    await expect(svc.removeCallIn({ id: 9, tenantId: T })).rejects.toMatchObject({ status: 409 });
    expect(tx.attendanceCallIn.delete).not.toHaveBeenCalled();
  });
});

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
const db = {
  attendanceAnomaly: { findMany: jest.fn(), updateMany: jest.fn() },
};
const enqueue = jest.fn();
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: db }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: async (_, fn) => fn(db),
}));
jest.unstable_mockModule('../../src/services/hrDomainEvent.service.js', () => ({
  enqueueHrDomainEvent: enqueue,
}));
const { escalateAttendanceRequests } =
  await import('../../src/jobs/attendance-escalation.loop.js');
const now = new Date('2026-10-10T12:00Z');
const request = () => ({
  id: 7,
  tenantId: 'tenant-a',
  employeeId: 1,
  status: 'PENDING',
  workflowVersion: 3,
  currentApprovalLevel: 1,
  approvalEnteredAt: '2026-10-09T08:00Z',
  routingSnapshot: [
    { level: 1, approverId: 2, resolved: true, autoEscalateAfterHours: 24 },
    { level: 2, approverId: 3, resolved: true },
  ],
});
beforeEach(() => {
  jest.resetAllMocks();
  db.attendanceAnomaly.findMany.mockResolvedValue([request()]);
  db.attendanceAnomaly.updateMany.mockResolvedValue({ count: 1 });
});
describe('dated approval escalation', () => {
  it('advances responsibility without approving and enqueues an event in the same transaction', async () => {
    expect(await escalateAttendanceRequests({ now })).toMatchObject({
      advanced: 1,
    });
    const { where, data } = db.attendanceAnomaly.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({
      tenantId: 'tenant-a',
      status: 'PENDING',
      workflowVersion: 3,
      currentApprovalLevel: 1,
    });
    expect(data.currentApprovalLevel).toBe(2);
    expect(data.status).toBeUndefined();
    expect(enqueue).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        eventName: 'hr.attendance.approval_escalated.v1',
        payload: expect.objectContaining({ approverId: '3' }),
      }),
    );
  });
  it('does not bypass an unresolved mandatory step', async () => {
    const row = request();
    row.routingSnapshot.splice(1, 0, {
      level: 1.5,
      resolved: false,
      skippable: false,
    });
    db.attendanceAnomaly.findMany.mockResolvedValue([row]);
    expect((await escalateAttendanceRequests({ now })).advanced).toBe(0);
    expect(db.attendanceAnomaly.updateMany).not.toHaveBeenCalled();
  });
  it('does not escalate before the timeout', async () => {
    expect(
      (await escalateAttendanceRequests({ now: new Date('2026-10-09T10:00Z') }))
        .advanced,
    ).toBe(0);
  });
  it('does not enqueue a stale decision after a concurrent approval', async () => {
    db.attendanceAnomaly.updateMany.mockResolvedValue({ count: 0 });
    await escalateAttendanceRequests({ now });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('paginates past old unresolved requests instead of starving later requests', async () => {
    db.attendanceAnomaly.findMany.mockResolvedValue(
      Array.from({ length: 1000 }, (_, i) => ({
        ...request(),
        id: i + 10,
        routingSnapshot: [],
      })),
    );
    expect(
      (await escalateAttendanceRequests({ now, afterId: 9 })).nextCursor,
    ).toBe(1009);
    expect(db.attendanceAnomaly.findMany.mock.calls[0][0].where.id).toEqual({
      gt: 9,
    });
  });
});

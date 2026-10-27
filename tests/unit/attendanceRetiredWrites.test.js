// Legacy routes remain closed; positive HR/Management flows are exercised by
// attendanceRules.workflow.test.js against the real evaluator and audit writer.
import { describe, it, expect, jest } from '@jest/globals';
const write = jest.fn(() => { throw new Error('Retired API attempted a write'); });
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: {
  attendance: { create: write, update: write, upsert: write },
  attendanceAnomaly: { create: write, update: write },
  log: { create: write }, $transaction: write,
} }));
const { correctAttendanceDay } = await import('../../src/services/attendanceCorrection.service.js');
const { updateAnomaly } = await import('../../src/services/attendanceAnomaly.service.js');
const { createAnomalyRequest } = await import('../../src/services/attendanceAnomalyRequest.service.js');
const { decideAnomaly } = await import('../../src/services/attendanceAnomalyRouting.service.js');

describe.each([correctAttendanceDay, updateAnomaly, createAnomalyRequest, decideAnomaly])('%s retirement', operation => {
  it.each(['Employee', 'HR', 'Management', 'Admin'])('rejects legacy writes even for %s without changing evidence or decisions', async role => {
    write.mockClear();
    await expect(operation({ tenantId: 'tenant-1', employeeId: 42, actorEmployeeId: 2,
      user: { roles: [role], employeeId: 2 }, id: 1, anomalyId: 1,
      date: '2026-08-14', checkIn: '09:00', checkOut: '17:00', type: 'ABSENT',
      decision: 'APPROVED', reason: 'Legacy request', isHR: true,
    })).rejects.toMatchObject({ status: 410, message: expect.stringContaining('Attendance anomaly review') });
    expect(write).not.toHaveBeenCalled();
  });
});

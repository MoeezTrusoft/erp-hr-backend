import { describe, it, expect } from '@jest/globals';
import { receiveCapture } from '../../src/services/attendanceCapture.service.js';
import { captureDb, TENANT, OTHER_TENANT } from '../helpers/captureDb.js';
describe('fleet capture attribution', () => {
  it('stores each employee in their permitted tenant within one receipt', async () => {
    const db = captureDb({ employeeDeviceEnrolment: [
      { id: 1, employeeId: 1, tenantId: TENANT, deviceUserId: '101', sn: 'DEVICE-1', effectiveFrom: new Date('2026-01-01') },
      { id: 2, employeeId: 2, tenantId: OTHER_TENANT, deviceUserId: '202', sn: 'DEVICE-1', effectiveFrom: new Date('2026-01-01') },
    ] });
    await receiveCapture({ sn: 'DEVICE-1', rows: ['101\t2026-10-01 09:00:00\t0', '202\t2026-10-01 09:00:00\t0'] }, db);
    expect(db.snapshot().attendanceCaptureEvent.map(e => [e.employeeId, e.tenantId])).toEqual([[1,TENANT],[2,OTHER_TENANT]]);
    expect(db.snapshot().attendanceCaptureReceipt).toHaveLength(1);
  });
  it('unknown users remain in the device owner review queue and never create employees', async () => {
    const db = captureDb(); await receiveCapture({ sn: 'DEVICE-1', rows: ['UNKNOWN\t2026-10-01 09:00:00\t0'] }, db);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({ tenantId: TENANT, state: 'NEEDS_REVIEW', reason: 'UNKNOWN_IDENTITY' });
    expect(db.snapshot().employee).toHaveLength(1);
  });
});

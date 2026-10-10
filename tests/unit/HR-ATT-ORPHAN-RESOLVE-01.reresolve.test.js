import { describe, it, expect } from '@jest/globals';
import { captureDb, TENANT, OTHER_TENANT } from '../helpers/captureDb.js';
import { receiveCapture, reconcileCaptureIdentities } from '../../src/services/attendanceCapture.service.js';
const enrolment = { tenantId: OTHER_TENANT, employeeId: 2, deviceUserId: 'unknown', sn: 'DEVICE-1', effectiveFrom: new Date('2026-01-01'), effectiveTo: null };
async function unknown() {
  const db = captureDb();
  await receiveCapture({ sn: 'DEVICE-1', rows: ['unknown\t2026-09-01 05:02:00\t1'] }, db);
  return db;
}
describe('late enrolment recovery', () => {
  it('routes to the permitted employee tenant and queues evaluation with both companies audited', async () => {
    const db = await unknown();
    await db.employeeDeviceEnrolment.create({ data: enrolment });
    await reconcileCaptureIdentities({}, db);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({ tenantId: OTHER_TENANT, employeeId: 2, state: 'PENDING' });
    const audit = db.snapshot().attendanceCaptureAudit.filter(r => r.action.startsWith('IDENTITY_'));
    expect(new Set(audit.map(r => r.tenantId))).toEqual(new Set([TENANT, OTHER_TENANT]));
  });
  it('does not infer identity from a current biometric ID', async () => {
    const db = await unknown();
    await db.employee.create({ data: { id: 2, tenant_id: TENANT, biometric_id: 'unknown' } });
    await reconcileCaptureIdentities({}, db);
    expect(db.snapshot().attendanceCaptureEvent[0].state).toBe('NEEDS_REVIEW');
    expect(db.snapshot().attendance).toHaveLength(0);
  });
  it.each([
    ['wrong serial', { sn: 'DEVICE-OTHER' }],
    ['outside enrolment dates', { effectiveFrom: new Date('2026-09-02') }],
    ['unauthorized company', { tenantId: '30000000-0000-4000-8000-000000000003' }],
  ])('leaves %s evidence unresolved', async (_label, patch) => {
    const db = await unknown();
    await db.employeeDeviceEnrolment.create({ data: { ...enrolment, ...patch } });
    await reconcileCaptureIdentities({}, db);
    expect(db.snapshot().attendanceCaptureEvent[0].state).toBe('NEEDS_REVIEW');
  });
  it('does not choose an arbitrary overlapping enrolment', async () => {
    const db = await unknown();
    await db.employeeDeviceEnrolment.create({ data: enrolment });
    await db.employeeDeviceEnrolment.create({ data: { ...enrolment, employeeId: 3 } });
    await reconcileCaptureIdentities({}, db);
    expect(db.snapshot().attendanceCaptureEvent[0].state).toBe('NEEDS_REVIEW');
  });
  it('recovery is idempotent and preserves original evidence', async () => {
    const db = await unknown();
    const original = db.snapshot().attendanceCaptureEvent[0];
    await db.employeeDeviceEnrolment.create({ data: { ...enrolment, tenantId: TENANT } });
    await reconcileCaptureIdentities({}, db);
    await reconcileCaptureIdentities({}, db);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({ raw: original.raw, fingerprint: original.fingerprint, parsed: original.parsed });
    expect(db.snapshot().attendanceCaptureAudit.filter(a => a.action === 'IDENTITY_RESOLVED')).toHaveLength(1);
  });
});

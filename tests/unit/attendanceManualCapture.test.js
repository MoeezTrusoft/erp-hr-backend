import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { captureDb, TENANT, OTHER_TENANT } from '../helpers/captureDb.js';
import { publishedSetup } from '../helpers/publishedSetup.js';
let db;
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: new Proxy({}, { get: (_target, key) => db[key] }) }));
const { checkIn, checkOut } = await import('../../src/controllers/attendance.controller.js');
const { receiveCapture } = await import('../../src/services/attendanceCapture.service.js');
const reply = () => ({ code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const user = { tenantId: TENANT, userId: 'verified-operator' };
beforeEach(() => { db = captureDb({ attendanceSetupRelease: publishedSetup({ tenantId: TENANT }) }); });

describe('the direct check-in and check-out routes are closed', () => {
  it('answers that a manual punch is sent for approval first and records nothing', async () => {
    for (const handler of [checkIn, checkOut]) {
      const res = reply();
      await handler({ user, body: { employeeId: 1, timestamp: '2026-10-01T04:00:00Z', notes: 'Reception register' } }, res);
      expect(res.code).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).toMatch(/sent for approval first/);
    }
    expect(db.snapshot().attendanceCaptureReceipt).toHaveLength(0);
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(0);
  });
});

// What an approved manual punch is recorded with (captureChangeRequest.service.js calls receiveCapture like this).
const manual = (over = {}) => ({ source: 'MANUAL', tenantId: TENANT, actorId: 'verified-operator', manualEmployeeId: 1, ...over });
describe('manual capture recorded by an approval', () => {
  it('retains the verified actor, the original note and an idempotent receipt', async () => {
    const args = manual({ requestKey: 'manual-1', notes: 'Reception register', rows: ['1\t2026-10-01T04:00:00Z\t0\t0\t0'] });
    expect((await receiveCapture(args, db)).stored).toBe(1);
    expect(db.snapshot().attendance).toHaveLength(0);
    expect(db.snapshot().attendanceCaptureReceipt[0]).toMatchObject({ tenantId: TENANT, actorId: 'verified-operator' });
    expect(db.snapshot().attendanceCaptureEvent[0].raw.notes).toBe('Reception register');
    expect((await receiveCapture(args, db)).replayed).toBe(true);
    expect(db.snapshot().attendanceCaptureReceipt).toHaveLength(1);
  });
  it('retains an explicit check-out direction and note', async () => {
    await receiveCapture(manual({ notes: 'Verified departure', rows: ['1\t2026-10-01T13:00:00Z\t1\t0\t0'] }), db);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({ source: 'MANUAL', parsed: { status: 1 }, raw: { notes: 'Verified departure' } });
  });
  it('holds an invalid supplied timestamp without replacing it with now', async () => {
    await receiveCapture(manual({ rows: ['1\tinvalid\t0\t0\t0'] }), db);
    expect(db.snapshot().attendanceCaptureEvent[0].state).toBe('NEEDS_REVIEW');
    expect(db.snapshot().attendanceCaptureEvent[0].raw.line).toContain('invalid');
  });
  it('cannot capture another company employee', async () => {
    await db.employee.create({ data: { id: 2, tenant_id: OTHER_TENANT } });
    await expect(receiveCapture(manual({ manualEmployeeId: 2, rows: ['2\t2026-10-01T04:00:00Z\t0\t0\t0'] }), db)).rejects.toThrow(/not found/i);
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(0);
  });
});

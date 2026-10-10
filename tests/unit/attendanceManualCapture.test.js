import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { captureDb, TENANT, OTHER_TENANT } from '../helpers/captureDb.js';
import { publishedSetup } from '../helpers/publishedSetup.js';
let db;
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: new Proxy({}, { get: (_target, key) => db[key] }) }));
const { checkIn, checkOut } = await import('../../src/controllers/attendance.controller.js');
const reply = () => ({ code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const user = { tenantId: TENANT, userId: 'verified-operator' };
beforeEach(() => { db = captureDb({ attendanceSetupRelease: publishedSetup({ tenantId: TENANT }) }); });
describe('manual capture transport', () => {
  it('returns accepted and retains verified actor, original note and idempotent receipt', async () => {
    const req = { user, body: { tenantId: OTHER_TENANT, actorId: 'spoofed', employeeId: 1, timestamp: '2026-10-01T04:00:00Z', requestKey: 'manual-1', notes: 'Reception register' } };
    const res = reply(); await checkIn(req, res);
    expect(res.code).toBe(202);
    expect(db.snapshot().attendance).toHaveLength(0);
    expect(db.snapshot().attendanceCaptureReceipt[0]).toMatchObject({ tenantId: TENANT, actorId: user.userId });
    expect(db.snapshot().attendanceCaptureEvent[0].raw.notes).toBe('Reception register');
    await checkIn(req, reply());
    expect(db.snapshot().attendanceCaptureReceipt).toHaveLength(1);
  });
  it('retains explicit checkout direction and notes', async () => {
    const res = reply();
    await checkOut({ user, body: { employeeId: 1, timestamp: '2026-10-01T13:00:00Z', notes: 'Verified departure' } }, res);
    expect(res.code).toBe(202);
    expect(db.snapshot().attendanceCaptureEvent[0]).toMatchObject({ source: 'MANUAL', parsed: { status: 1 }, raw: { notes: 'Verified departure' } });
  });
  it('holds an invalid supplied timestamp without replacing it with now', async () => {
    const res = reply(); await checkIn({ user, body: { employeeId: 1, timestamp: 'invalid' } }, res);
    expect(res.code).toBe(202);
    expect(db.snapshot().attendanceCaptureEvent[0].state).toBe('NEEDS_REVIEW');
    expect(db.snapshot().attendanceCaptureEvent[0].raw.line).toContain('invalid');
  });
  it('cannot use the body tenant to capture another company employee', async () => {
    await db.employee.create({ data: { id: 2, tenant_id: OTHER_TENANT } });
    const res = reply(); await checkIn({ user, body: { employeeId: 2, tenantId: OTHER_TENANT, timestamp: '2026-10-01T04:00:00Z' } }, res);
    expect(res.code).toBeGreaterThanOrEqual(400);
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(0);
  });
});

// Exercise the sync adapter, durable queue, published resolver and real writer.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { captureDb, TENANT } from '../helpers/captureDb.js';
import { publishedSetup } from '../helpers/publishedSetup.js';
let db;
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: new Proxy({}, { get: (_target, key) => db[key] }) }));
const { syncAttendanceFromPunches } = await import('../../src/services/attendance.device.service.js');
const { drainCapture } = await import('../../src/services/attendanceCaptureWorker.service.js');
const now = new Date('2027-01-01');
const punch = (timestamp, type) => ({ deviceUserId: '101', timestamp, type });
const records = () => db.snapshot().attendance.filter(r => r.check_in || r.check_out);
async function sync(punches) {
  const receipt = await syncAttendanceFromPunches({ sn: 'DEVICE-1', tenantId: TENANT, punches, dryRun: false });
  expect(receipt.pending).toBe(punches.length);
  expect((await drainCapture({ now }, db)).failed).toBe(0);
}
function setup(from = '22:00', to = '08:00') {
  db = captureDb({ attendanceSetupRelease: publishedSetup({ tenantId: TENANT, schedules: [{ effective_start_date: '2020-01-01', schedule_pattern: { type: 'weekly', shift: { from, to }, offDays: [] } }] }) });
}
beforeEach(() => setup());
describe('sync capture uses published shift evaluation', () => {
  it('keeps an overnight shift on its start date', async () => {
    await sync([punch('2026-08-14T22:04:00','IN'), punch('2026-08-15T05:53:00','OUT')]);
    expect(records()).toHaveLength(1);
    expect(records()[0].date.toISOString().slice(0,10)).toBe('2026-08-14');
    expect(records()[0].total_hours).toBeCloseTo(7.82, 1);
  });
  it('separates successive day shifts', async () => {
    setup('10:00','18:00');
    await sync([punch('2026-08-14T10:02:00','IN'),punch('2026-08-14T18:10:00','OUT'),punch('2026-08-15T10:05:00','IN'),punch('2026-08-15T18:01:00','OUT')]);
    expect(records().map(r => r.date.getUTCDate()).sort()).toEqual([14,15]);
  });
  it('completes an earlier shift when the departure arrives in a later receipt', async () => {
    await sync([punch('2026-08-14T22:04:00','IN')]);
    expect(records()[0].status).toBe('MISSING_CHECKOUT');
    await sync([punch('2026-08-15T05:53:00','OUT')]);
    expect(records()).toHaveLength(1);
    expect(records()[0].total_hours).toBeCloseTo(7.82, 1);
  });
  it('retains manual correction while retaining new raw evidence', async () => {
    const corrected = await db.attendance.create({ data: { tenantId: TENANT, employeeId: 1, date: new Date('2026-08-14'), check_in: new Date('2026-08-14T22:00:00Z'), total_hours: 10, status: 'PRESENT', manually_corrected: true } });
    await sync([punch('2026-08-14T23:30:00','IN')]);
    expect(records()[0]).toEqual(corrected);
    expect(db.snapshot().attendanceDevicePunch).toHaveLength(1);
  });
  it('judges lateness against the published night shift', async () => {
    await sync([punch('2026-08-14T22:15:00','IN'),punch('2026-08-15T08:00:00','OUT')]);
    expect(records()[0].status).toBe('LATE');
  });
  it('recognizes an after-midnight arrival as late to its night shift', async () => {
    await sync([punch('2026-08-15T00:30:00','IN'),punch('2026-08-15T08:00:00','OUT')]);
    expect(records()[0].status).toBe('LATE');
    expect(records()[0].date.getUTCDate()).toBe(14);
  });
  it('recognizes a pre-midnight arrival as early for a midnight shift', async () => {
    setup('00:00','10:00');
    await sync([punch('2026-08-11T23:05:15','IN'),punch('2026-08-12T10:00:00','OUT')]);
    expect(records()[0].status).toBe('PRESENT');
    expect(records()[0].date.getUTCDate()).toBe(12);
  });
  it('marks a completed on-time day shift present', async () => {
    setup('10:00','18:00');
    await sync([punch('2026-08-14T09:58:00','IN'),punch('2026-08-14T18:00:00','OUT')]);
    expect(records()[0].status).toBe('PRESENT');
  });
  it('preview creates no evidence or attendance', async () => {
    const result = await syncAttendanceFromPunches({ sn: 'DEVICE-1', tenantId: TENANT, punches: [punch('2026-08-14T22:04:00','IN')] });
    expect(result.dryRun).toBe(true);
    expect(db.snapshot().attendanceCaptureEvent).toHaveLength(0);
    expect(records()).toHaveLength(0);
  });
});

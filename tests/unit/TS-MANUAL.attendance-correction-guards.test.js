// TS-MANUAL-04 / TS-MANUAL-05 / TS-MANUAL-01 — manual attendance server guards
// (operator items 2.1/2.4, 8, 9 — rulings 2026-09-17).
//
//   • atClock accepts HH:MM:SS (seconds truncated) — the operator's payload
//     `15:00:23` previously 400'd with "Time must be HH:MM".
//   • Future dates are rejected on the PKT calendar (+05:00), so a late-evening
//     "tomorrow" payload is refused but 2 AM PKT "today" is not.
//   • Punch integrity: a correction may never ALTER a recorded punch; it may
//     only supply the missing one (same-time payload = idempotent, allowed).
//
// The service module is imported for its exported correctAttendanceDay surface;
// atClock/describeHhmm are internal, so the guards are exercised through the
// public function with a mocked prisma (the established pattern in
// HR-ATT-CORRECTION tests) plus direct import of the module under a temp
// export seam where needed.
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const auditCreates = [];
const attendanceUpserts = [];

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    attendance: {
      findFirst: jest.fn(async ({ where }) => attendanceUpserts.state?.existing ?? null),
      create: jest.fn(async ({ data }) => ({ id: 9001, ...data })),
      update: jest.fn(async ({ data }) => ({ id: 9001, ...attendanceUpserts.state?.existing, ...data })),
    },
    employee: {
      findUnique: jest.fn(async () => ({
        id: 484, tenant_id: 't-1', work_mode: 'Onsite',
      })),
    },
    log: { create: jest.fn(async ({ data }) => { auditCreates.push(data); return { id: 1, ...data }; }) },
  },
}));

jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: jest.fn(async (_prisma, fn) => fn(_prisma)),
}));

const { correctAttendanceDay } = await import('../../src/services/attendanceCorrection.service.js');

const DAY = '2026-09-17T00:00:00.000Z';

const baseArgs = () => ({
  tenantId: 't-1',
  employeeId: 484,
  date: DAY,
  workMode: 'Remote',
  reason: 'test correction',
  actorEmployeeId: 558,
});

beforeEach(() => {
  attendanceUpserts.state = null;
  auditCreates.length = 0;
});

describe('TS-MANUAL-04 — HH:MM:SS accepted, seconds truncated', () => {
  it('accepts the operator payload shape (checkIn 15:00:23)', async () => {
    const res = await correctAttendanceDay({ ...baseArgs(), checkIn: '15:00:23', checkOut: null });
    expect(new Date(res.check_in).getUTCHours()).toBe(15);
    expect(new Date(res.check_in).getUTCMinutes()).toBe(0);
    expect(new Date(res.check_in).getUTCSeconds()).toBe(0);
  });

  it('still rejects garbage times', async () => {
    await expect(
      correctAttendanceDay({ ...baseArgs(), checkIn: '1500', checkOut: null }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('TS-MANUAL-01 — future dates rejected on the PKT calendar', () => {
  it('rejects a clearly-future date', async () => {
    const future = new Date(Date.now() + 5 * 3600 * 1000);
    future.setUTCDate(future.getUTCDate() + 2);
    await expect(
      correctAttendanceDay({ ...baseArgs(), date: future.toISOString().slice(0, 10), checkIn: '09:00' }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Attendance cannot be entered or corrected for a future date',
    });
  });
});

describe('TS-MANUAL-05 — punch immutability', () => {
  it('rejects altering a recorded check-in (criminal case from item 9)', async () => {
    attendanceUpserts.state = {
      existing: {
        id: 77, employeeId: 484, date: new Date(DAY),
        check_in: new Date('2026-09-17T10:00:00.000Z'), check_out: null,
        status: 'MISSING_CHECKOUT', requires_regularization: false,
      },
    };
    await expect(
      correctAttendanceDay({ ...baseArgs(), checkIn: '15:00:00', checkOut: '23:00' }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('immutable') });
  });

  it('allows supplying ONLY the missing check-out (same check-in not resent)', async () => {
    attendanceUpserts.state = {
      existing: {
        id: 77, employeeId: 484, date: new Date(DAY),
        check_in: new Date('2026-09-17T10:00:00.000Z'), check_out: null,
        status: 'MISSING_CHECKOUT', requires_regularization: false,
      },
    };
    const res = await correctAttendanceDay({ ...baseArgs(), checkIn: null, checkOut: '23:00' });
    expect(res.check_out).toBeTruthy();
    expect(res.status).toBe('PRESENT');
  });
});

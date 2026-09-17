// HR-ANOM-DEADLINE-01 — the 2-working-day request window.
//
// Operator ruling 2026-09-16: "The employees has 2 working days of deadline to
// submit an anomaly request. If the anomaly is about late, missing in/outs the
// anomaly request deadline should include the current working anomaly day as
// well." LATE / MISSING_CHECKIN / MISSING_CHECKOUT count the anomaly day as
// working day 1; every other type starts counting the day after. Roster-driven
// (resolveWorkingDays), so weekends and holidays never consume the window.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Working days: Mon Sep 7 … Fri Sep 11, Mon Sep 14 … (Sat/Sun off).
// Map keys mirror resolveWorkingDays: UTC YYYY-MM-DD, ascending.
const workingDaysOf = (from, to) => {
  const out = new Map();
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d.getTime() <= end.getTime()) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    out.set(iso, { working: dow !== 0 && dow !== 6, date: new Date(iso) });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

const prismaMock = {
  workSchedule: { findFirst: jest.fn(async () => null) },
  employee: {
    findUnique: jest.fn(async () => ({
      id: 1, employee_code: 'EMP-001', employee_name: 'Test Emp', first_name: 'Test', last_name: 'Emp',
      job_title: null, Position: null, businessUnit: null,
    })),
  },
  attendance: { findFirst: jest.fn(async () => null) },
  attendanceAnomaly: {
    findFirst: jest.fn(async () => null),
    create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
  },
  $transaction: jest.fn(async (fn) => fn({
    attendanceAnomaly: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
    },
  })),
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: jest.fn(async (_p, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/services/workingDay.service.js', () => ({
  resolveWorkingDays: jest.fn(async ({ from, to }) => workingDaysOf(from, to)),
}));
jest.unstable_mockModule('../../src/services/attendanceAnomalyRouting.service.js', () => ({
  routeAnomaly: jest.fn(async () => ({ routed: false })),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const svc = await import('../../src/services/attendanceAnomalyRequest.service.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('HR-ANOM-DEADLINE-01 computeAnomalyDeadline', () => {
  it('LATE on Monday: window = Mon (day 1) + Tue (day 2) → deadline Tuesday', async () => {
    const { deadline } = await svc.computeAnomalyDeadline({
      employeeId: 1, anomalyDate: new Date('2026-09-07T12:00:00Z'), type: 'LATE_CHECKIN',
    });
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-09-08');
  });

  it('LATE on Friday: Friday (1) + Monday (2) — the weekend consumes nothing', async () => {
    const { deadline } = await svc.computeAnomalyDeadline({
      employeeId: 1, anomalyDate: new Date('2026-09-11T12:00:00Z'), type: 'MISSING_CHECKOUT',
    });
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-09-14');
  });

  it('ABSENCE-type on Monday: starts the day AFTER → Wednesday', async () => {
    const { deadline } = await svc.computeAnomalyDeadline({
      employeeId: 1, anomalyDate: new Date('2026-09-07T12:00:00Z'), type: 'ABSENT',
    });
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-09-09');
  });

  it('LATE on a holiday Friday: the weekend+holiday consume nothing → Mon 14 + Tue 15', async () => {
    // Fri Sep 11 is a holiday; the anomaly day itself cannot be working day 1.
    // Candidates from Fri: Mon 14 (day 1), Tue 15 (day 2).
    const withHoliday = workingDaysOf('2026-09-07', '2026-09-30');
    withHoliday.set('2026-09-11', { working: false, date: new Date('2026-09-11') });
    const mod = await import('../../src/services/workingDay.service.js');
    mod.resolveWorkingDays.mockResolvedValueOnce(withHoliday);
    const { deadline } = await svc.computeAnomalyDeadline({
      employeeId: 1, anomalyDate: new Date('2026-09-11T12:00:00Z'), type: 'LATE_CHECKIN',
    });
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('MISSING_CHECKOUT on Saturday (off day): counts the next working days, not the off day', async () => {
    const { deadline } = await svc.computeAnomalyDeadline({
      employeeId: 1, anomalyDate: new Date('2026-09-12T12:00:00Z'), type: 'MISSING_CHECKOUT',
    });
    // Sat not working → day 1 is Mon 14, day 2 is Tue 15.
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('HR-ANOM-DEADLINE-PKT: window closes at KARACHI midnight, not UTC midnight', async () => {
    // LATE on Mon Sep 7 → deadline Tue Sep 8 23:59:59 PKT = 18:59:59Z.
    // The old UTC build produced 2026-09-08T23:59:59.000Z, which lapsed at
    // 04:59:59 AM PKT on Sep 9 — five hours into an employee's morning.
    const { deadline } = await svc.computeAnomalyDeadline({
      employeeId: 1, anomalyDate: new Date('2026-09-07T12:00:00Z'), type: 'LATE_CHECKIN',
    });
    expect(deadline.toISOString()).toBe('2026-09-08T18:59:59.000Z');
  });

  it('HR-ANOM-DEADLINE-PKT: at 23:00 PKT on deadline day the window is still open', async () => {
    // Deadline Tue Sep 8 23:59:59 PKT = 18:59:59Z. Real clock (frozen just
    // before) is 2026-09-08T17:00:00Z = 22:00 PKT — an employee filing late
    // on deadline evening must get through. The UTC build would have the
    // same verdict here, but 04:00 PKT Sep 9 (23:00Z Sep 8) must now REJECT.
    const { deadline } = await svc.computeAnomalyDeadline({
      employeeId: 1, anomalyDate: new Date('2026-09-07T12:00:00Z'), type: 'LATE_CHECKIN',
    });
    expect(new Date('2026-09-08T17:00:00Z').getTime()).toBeLessThan(deadline.getTime());
    expect(new Date('2026-09-08T23:00:00Z').getTime()).toBeGreaterThan(deadline.getTime());
  });
});

describe('HR-ANOM-DEADLINE-01 enforcement on submit', () => {
  it('rejects a request past the window with a clear message', async () => {
    // Freeze "now" far past any window: the service reads the real clock via
    // new Date(); simulate by asking for an old anomaly date.
    const { resolveWorkingDays } = await import('../../src/services/workingDay.service.js');
    resolveWorkingDays.mockImplementationOnce(async ({ from, to }) => workingDaysOf(from, to));
    await expect(
      svc.createAnomalyRequest({
        tenantId: 't', employeeId: 1, date: new Date('2026-08-03T12:00:00Z'), reason: 'too late',
      }),
    ).rejects.toThrow(/2 working days/);
  });

  it('stamps requestDeadline on an in-window submission (today, LATE)', async () => {
    const { resolveWorkingDays } = await import('../../src/services/workingDay.service.js');
    resolveWorkingDays.mockImplementation(async ({ from, to }) => workingDaysOf(from, to));
    // attendance row with LATE_CHECKIN derives the self-inclusive category;
    // anomaly date = today keeps the window open against the real clock.
    prismaMock.attendance.findFirst.mockResolvedValueOnce({
      status: 'LATE_CHECKIN', check_in: new Date('2026-09-16T10:11:00Z'), date: new Date('2026-09-16T00:00:00Z'),
    });
    const today = new Date();
    const res = await svc.createAnomalyRequest({
      tenantId: 't', employeeId: 1, date: today, reason: 'traffic',
    });
    expect(res.anomaly.requestDeadline).toBeTruthy();
    expect(new Date(res.anomaly.requestDeadline).getTime()).toBeGreaterThan(Date.now());
  });
});

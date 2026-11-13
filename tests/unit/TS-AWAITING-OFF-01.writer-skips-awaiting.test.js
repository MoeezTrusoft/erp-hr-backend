// TS-AWAITING-OFF-01 — a shift with no verdict yet (PENDING_ATTENDANCE) is not an
// attendance record: the writer must not create a row for it, but must keep the
// evaluation job so the day is written when its deadline passes.
import { describe, it, expect } from '@jest/globals';
import { captureDb, TENANT } from '../helpers/captureDb.js';
import { applyEvaluatedShifts } from '../../src/services/attendanceWriter.service.js';

const config = {
  version: 3,
  settings: { timeZone: 'Asia/Karachi', defaultCalendarId: 1, profiles: [], assignments: [], staffingTargets: [] },
  policy: { graceMinutes: 5 },
  employees: [{ id: 1, payroll_included: true, hire_date: '2026-01-01' }],
  periods: [],
  schedules: [
    {
      employeeId: 1,
      effective_start_date: '2026-01-01',
      schedule_pattern: { shift: { from: '09:00', to: '18:00' }, offDays: [] },
    },
  ],
  calendars: [{ id: 1, year: 2026 }],
  holidays: [],
  calendarAssignments: [],
};
const database = () =>
  captureDb({
    attendanceSetupRelease: [
      {
        id: 3,
        tenantId: TENANT,
        version: 3,
        effectiveFrom: new Date('2026-01-01'),
        coverageThrough: new Date('2026-12-31'),
        config,
      },
    ],
  });
const run = (db, now) =>
  applyEvaluatedShifts({
    tenantId: TENANT,
    from: '2026-10-07',
    to: '2026-10-07',
    dryRun: false,
    now,
    db,
  });

describe('Awaiting attendance rows', () => {
  it('are not created while the shift is still open, but the day stays scheduled', async () => {
    const db = database();
    // 11:00 local (06:00Z): the 09:00-18:00 shift is running and nobody has punched.
    const summary = await run(db, new Date('2026-10-07T06:00:00Z'));
    expect(summary.awaiting).toBe(1);
    expect(summary.created).toBe(0);
    const snap = db.snapshot();
    expect(snap.attendance.filter((r) => r.status === 'PENDING_ATTENDANCE')).toHaveLength(0);
    expect(snap.attendance).toHaveLength(0);
    expect(snap.attendanceEvaluationJob).toHaveLength(1);
    expect(snap.attendanceEvaluationJob[0]).toMatchObject({ state: 'PENDING' });
  });
  it('become a real record once the deadline passes', async () => {
    const db = database();
    await run(db, new Date('2026-10-07T06:00:00Z'));
    // Next morning, well past the checkout deadline: the day is judged.
    await run(db, new Date('2026-10-08T12:00:00Z'));
    const rows = db.snapshot().attendance;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ABSENT');
  });
});

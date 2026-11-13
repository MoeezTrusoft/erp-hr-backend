// ATT-EXPLICIT-OUT-01 — a check-out the employee chose is a check-out.
//
// Trusoft, Thursday 1 Oct 2026: Subhan worked the 15:00–00:00 shift through
// to 09:51 on Friday 2 Oct and selected check-out. Friday's shift did not
// start until 15:00. The nine-hour close window (ATT-CLOSE-9H-01) ended at
// 09:00, so the punch was refused, opened Friday's session, and was stored as
// Friday's check-in. An explicit direction closes the shift it belongs to for
// as long as that shift can still be running: until the next rostered start.
// Position-inferred punches keep the nine-hour window.
import { describe, it, expect } from '@jest/globals';
import { sessioniseByRoster } from '../../src/lib/attendanceReplay.js';
import { evaluateShift } from '../../src/lib/attendanceEvaluator.js';
import { completeTimesheetRows } from '../../src/lib/timesheetRows.js';

const EVENING = { type: 'weekly', offDays: [], shift: { from: '15:00', to: '00:00' } };
const DAY = { type: 'weekly', offDays: [], shift: { from: '09:00', to: '17:00' } };
const at = (iso, hhmm, status = 0, extra = {}) => ({ punchedAt: new Date(`${iso}T${hhmm}:00.000Z`), status, ...extra });
const dayOf = (s) => s.day.toISOString().slice(0, 10);
const times = (s) => s.punches.map((p) => p.timestamp.toISOString().slice(11, 16));
const types = (s) => s.punches.map((p) => p.type);

describe('ATT-EXPLICIT-OUT-01 an explicit check-out closes its shift until the next rostered start', () => {
  it('keeps Subhan Thu 15:00 -> Fri 09:51 as the Thursday shift (device key trusted)', () => {
    const sessions = sessioniseByRoster([
      at('2026-10-01', '15:00'),
      at('2026-10-02', '09:51', 1),
      at('2026-10-02', '14:56'),
    ], EVENING);

    expect(sessions.map(dayOf)).toEqual(['2026-10-01', '2026-10-02']);
    expect(times(sessions[0])).toEqual(['15:00', '09:51']);
    expect(types(sessions[0])).toEqual(['IN', 'OUT']);
    expect(times(sessions[1])).toEqual(['14:56']);
  });

  it('honours a self-service check-out even where the tenant infers device direction from position', () => {
    // directionVerified marks the self-service tool's own choice; the policy
    // trusts nothing else on this tenant (legacyDirectionInference).
    const sessions = sessioniseByRoster([
      at('2026-10-01', '15:00', 0, { directionVerified: true }),
      at('2026-10-02', '09:51', 1, { directionVerified: true }),
      at('2026-10-02', '14:56', 0, { directionVerified: true }),
    ], EVENING, { legacyDirectionInference: true });

    expect(sessions.map(dayOf)).toEqual(['2026-10-01', '2026-10-02']);
    expect(times(sessions[0])).toEqual(['15:00', '09:51']);
    expect(types(sessions[0])).toEqual(['IN', 'OUT']);
    expect(types(sessions[1])).toEqual(['IN']);
  });

  it('a lone explicit check-out never opens a shift: it is the departure of a shift with a missing arrival', () => {
    const sessions = sessioniseByRoster([
      at('2026-10-02', '09:51', 1),
      at('2026-10-02', '14:56'),
      at('2026-10-03', '00:02', 1),
    ], EVENING);

    expect(sessions.map(dayOf)).toEqual(['2026-10-01', '2026-10-02']);
    expect(types(sessions[0])).toEqual(['OUT']);
    expect(times(sessions[1])).toEqual(['14:56', '00:02']);
  });

  it('does not reach past the next rostered start', () => {
    // 15:30 on Friday is after Friday's 15:00 start: Thursday cannot still be
    // running, so the punch belongs to Friday (a departure with no arrival).
    const sessions = sessioniseByRoster([
      at('2026-10-01', '15:00'),
      at('2026-10-02', '15:30', 1),
    ], EVENING);

    expect(sessions.map(dayOf)).toEqual(['2026-10-01', '2026-10-02']);
    expect(times(sessions[0])).toEqual(['15:00']);
    expect(types(sessions[1])).toEqual(['OUT']);
  });

  it('closes the evening shift until the next check-in window opens, even for a position-inferred punch', () => {
    // The next 15:00 shift opens its check-in window at 10:00: 09:51 still belongs to Thursday.
    const closed = sessioniseByRoster([
      at('2026-10-01', '15:00'),
      at('2026-10-02', '09:51', 1),
    ], EVENING, { legacyDirectionInference: true });
    expect(closed.map(dayOf)).toEqual(['2026-10-01']);

    // 10:30 is inside the next shift's check-in window, so it opens Friday's own session.
    const reopened = sessioniseByRoster([
      at('2026-10-01', '15:00'),
      at('2026-10-02', '10:30', 1),
    ], EVENING, { legacyDirectionInference: true });
    expect(reopened.map(dayOf)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('still lets a mis-stamped morning arrival open the day shift (CLOSE-9H guard unchanged)', () => {
    const sessions = sessioniseByRoster([
      at('2026-08-10', '09:02'),
      at('2026-08-10', '17:04'),
      at('2026-08-11', '08:58', 1),
    ], DAY);

    expect(sessions).toHaveLength(2);
    expect(dayOf(sessions[1])).toBe('2026-08-11');
  });
});

describe('ATT-EXPLICIT-OUT-01 the evaluator scores the late explicit departure instead of parking it', () => {
  const shift = {
    start: new Date('2026-10-01T15:00:00Z'),
    end: new Date('2026-10-02T00:00:00Z'),
    nextShiftStart: new Date('2026-10-02T15:00:00Z'),
  };
  const policy = { checkoutLeniencyMin: 240, graceMinutes: 10 };
  const now = new Date('2026-10-03T00:00:00Z');

  it('accepts the 09:51 check-out as Thursday\'s departure', () => {
    const verdict = evaluateShift({
      punches: [
        { timestamp: new Date('2026-10-01T15:00:00Z'), type: 'IN' },
        { timestamp: new Date('2026-10-02T09:51:00Z'), type: 'OUT' },
      ],
      shift, policy, now,
    });
    expect(verdict.status).not.toBe('PUNCH_CONFLICT');
    expect(verdict.checkOut).toEqual(new Date('2026-10-02T09:51:00Z'));
    expect(verdict.issues).toEqual([]);
  });

  it('respects a latest checkout HR configured on the roster', () => {
    const verdict = evaluateShift({
      punches: [
        { timestamp: new Date('2026-10-01T15:00:00Z'), type: 'IN' },
        { timestamp: new Date('2026-10-02T09:51:00Z'), type: 'OUT' },
      ],
      shift: { ...shift, checkoutCutoff: new Date('2026-10-02T08:00:00Z') }, policy, now,
    });
    expect(verdict.status).toBe('PUNCH_CONFLICT');
  });

  it('still parks a position-inferred punch beyond the cutoff for review', () => {
    const verdict = evaluateShift({
      punches: [
        { timestamp: new Date('2026-10-01T15:00:00Z'), type: 'IN' },
        { timestamp: new Date('2026-10-02T10:30:00Z'), type: 'OUT', inferred: true },
      ],
      shift, policy, now,
    });
    expect(verdict.status).toBe('PUNCH_CONFLICT');
    expect(verdict.issues.map((i) => i.code)).toContain('PUNCH_OUTSIDE_CHECKOUT_CUTOFF');
  });
});

describe('ATT-DUE-ROWS-01 the timesheet lists only days that are due', () => {
  const runtime = {
    resolve: (_id, day) => {
      const date = day.toISOString().slice(0, 10);
      if (date === '2026-10-18' || date === '2026-10-25') return { working: false, reason: 'OFF_DAY', timeZone: 'Asia/Karachi' };
      return { working: true, timeZone: 'Asia/Karachi', shift: { start: new Date(`${date}T15:00:00Z`), end: new Date(`${date}T23:59:00Z`) } };
    },
  };
  const dates = (rows) => rows.map((r) => r.date.toISOString().slice(0, 10));

  it('omits future working days and future weekly offs, and today\'s shift until it starts', () => {
    // Monday 19 Oct, 10:00 in Karachi (05:00Z): the 15:00 shift has not begun.
    const rows = completeTimesheetRows({
      records: [], employees: [{ id: 1 }], anomalies: [], runtime,
      from: '2026-10-17', to: '2026-10-31', now: new Date('2026-10-19T05:00:00Z'),
    });
    expect(dates(rows)).toEqual(['2026-10-17', '2026-10-18']);
    expect(rows.map((r) => r.status)).toEqual(['PENDING_ATTENDANCE', 'WEEKLY_OFF']);
  });

  it('lists today once its shift has started', () => {
    const rows = completeTimesheetRows({
      records: [], employees: [{ id: 1 }], anomalies: [], runtime,
      from: '2026-10-19', to: '2026-10-31', now: new Date('2026-10-19T10:30:00Z'),
    });
    expect(dates(rows)).toEqual(['2026-10-19']);
  });

  it('keeps a stored record on a future day and ignores an absence for a day not yet begun', () => {
    const rows = completeTimesheetRows({
      records: [{ employeeId: 1, date: new Date('2026-10-21'), status: 'ON_LEAVE', check_in: null, check_out: null, total_hours: 0 }],
      employees: [{ id: 1 }],
      anomalies: [{ employeeId: 1, date: new Date('2026-10-22'), type: 'ABSENT', evidenceState: 'ACTIVE' }],
      runtime, from: '2026-10-19', to: '2026-10-31', now: new Date('2026-10-19T10:30:00Z'),
    });
    expect(dates(rows).sort()).toEqual(['2026-10-19', '2026-10-21']);
  });
});

// HR-ROSTER-04 — a roster may work different hours on different days.
//
// schedule_pattern.shift holds ONE {from,to}, so a roster cannot say "Saturday
// is a short day". Akash is the worked example. His August, from HR's sheet:
//
//   weekdays  in 07:29-07:45   out 15:02-15:16
//   Saturdays in 10:18-10:35   out 11:55-13:42
//
// Judged against his single stored shift of 07:00-15:00, every Saturday is a
// 2-3 hour day that falls under the half-day threshold and lands as ABSENT —
// five unpaid days for work he actually did, and the punches were there the
// whole time.
//
// So the pattern gains an optional `shiftByDay`, keyed by ISO weekday
// (Monday=1 .. Sunday=7). A day with an entry uses it; every other day falls
// back to `shift` exactly as before. Absent the key, nothing changes — which is
// what keeps the other 74 rosters and the frozen August fixture untouched.
//
// This is deliberately NOT a per-date override. Per-date already exists as
// shift_assignments; this is for a recurring weekly shape, which is what a
// roster is.
import { describe, it, expect } from '@jest/globals';
import { shiftCandidates, shiftFor } from '../../src/lib/attendanceReplay.js';

// 2026-08-01 is a Saturday; 2026-08-03 a Monday.
const SAT = new Date('2026-08-01T00:00:00.000Z');
const MON = new Date('2026-08-03T00:00:00.000Z');

const AKASH = {
    type: 'weekly',
    offDays: [7],
    shift: { from: '07:30', to: '15:00' },
    shiftByDay: { 6: { from: '10:00', to: '13:00' } },
};

const PLAIN = { type: 'weekly', offDays: [7], shift: { from: '07:30', to: '15:00' } };

const hhmm = (d) => (d ? d.toISOString().slice(11, 16) : null);

describe('HR-ROSTER-04 per-weekday shift times', () => {
    it('uses the Saturday window on a Saturday', () => {
        const [win] = shiftCandidates(AKASH, SAT);

        expect(hhmm(win.start)).toBe('10:00');
        expect(hhmm(win.end)).toBe('13:00');
    });

    it('uses the default window on every other day', () => {
        const [win] = shiftCandidates(AKASH, MON);

        expect(hhmm(win.start)).toBe('07:30');
        expect(hhmm(win.end)).toBe('15:00');
    });

    it('leaves a roster without per-day hours exactly as it was', () => {
        expect(hhmm(shiftCandidates(PLAIN, SAT)[0].start)).toBe('07:30');
        expect(hhmm(shiftCandidates(PLAIN, MON)[0].start)).toBe('07:30');
    });

    it('makes Akash arriving 10:26 on a Saturday on time, not absent', () => {
        // The whole point. Against 07:00-15:00 a 10:26-12:37 day is a fraction
        // of a shift; against 10:00-13:00 it is a full one.
        const win = shiftFor(AKASH, SAT, new Date('2026-08-01T10:26:00.000Z'));

        expect(hhmm(win.start)).toBe('10:00');
        const lateMinutes = (new Date('2026-08-01T10:26:00.000Z') - win.start) / 60_000;
        expect(lateMinutes).toBe(26);
    });

    it('accepts the weekday key as a string, since JSON keys are strings', () => {
        // schedule_pattern round-trips through JSONB, so 6 comes back as "6".
        const stringKeyed = { ...AKASH, shiftByDay: { 6: { from: '10:00', to: '13:00' } } };

        expect(hhmm(shiftCandidates(stringKeyed, SAT)[0].start)).toBe('10:00');
    });

    it('ignores a malformed per-day entry rather than losing the shift', () => {
        // A bad entry must not silently erase the roster and turn every scan
        // into an unrostered day.
        const broken = { ...AKASH, shiftByDay: { 6: { from: 'nonsense' } } };

        expect(hhmm(shiftCandidates(broken, SAT)[0].start)).toBe('07:30');
    });

    it('still lets a rotating roster win — it has no weekday shape', () => {
        const rotating = {
            type: 'rotating',
            rotatingShifts: [{ from: '10:00', to: '22:00' }, { from: '22:00', to: '10:00' }],
            shiftByDay: { 6: { from: '10:00', to: '13:00' } },
        };

        expect(shiftCandidates(rotating, SAT)).toHaveLength(2);
    });
});

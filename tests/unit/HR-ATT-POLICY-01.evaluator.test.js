// HR-ATT-POLICY-01 — the attendance evaluator.
//
// Pure function, so no mocks: the inputs ARE the fixtures. That is the point of
// keeping it free of I/O — the shadow replay runs this exact code over 4314 real
// punches, and anything it cannot decide from its arguments would make that
// replay dishonest.
import { describe, it, expect } from '@jest/globals';
import { evaluateShift, DAY_CREDIT } from '../../src/lib/attendanceEvaluator.js';

const at = (iso) => new Date(iso);

// Day shift 10:00-18:00 (8h) and night shift 22:00-08:00 (10h), both real
// rosters from this fleet.
const DAY_SHIFT = { start: at('2026-08-14T10:00:00Z'), end: at('2026-08-14T18:00:00Z') };
const NIGHT_SHIFT = { start: at('2026-08-14T22:00:00Z'), end: at('2026-08-15T08:00:00Z') };

const POLICY = {
    graceMinutes: 15,
    halfDayAfterMinutes: 30,
    earlyLeaveGraceMin: 10,
    checkoutLeniencyMin: 240,
    fullDayMinPercent: 90,
    halfDayMinPercent: 50,
    duplicatePunchWindowMin: 5,
};

const CLOSED = { working: false, nextShiftStart: null };
const LATER = at('2026-08-20T00:00:00Z');   // well past every cutoff below

const IN = (iso) => ({ timestamp: at(iso), type: 'IN' });
const OUT = (iso) => ({ timestamp: at(iso), type: 'OUT' });

describe('HR-ATT-POLICY-01 arrival', () => {
    it('is PRESENT inside the grace window', () => {
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:12:00Z'), OUT('2026-08-14T18:00:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.status).toBe('PRESENT');
        expect(r.dayCredit).toBe(DAY_CREDIT.FULL);
    });

    it('is LATE past grace but still a FULL day credit', () => {
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:20:00Z'), OUT('2026-08-14T18:30:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.status).toBe('LATE');
        expect(r.dayCredit).toBe(DAY_CREDIT.FULL);   // the flag is the penalty
        expect(r.anomalies.map((a) => a.type)).toContain('LATE_CHECKIN');
    });

    it('is HALF_DAY once lateness reaches the half-day threshold', () => {
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:35:00Z'), OUT('2026-08-14T18:30:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.status).toBe('HALF_DAY');
        expect(r.dayCredit).toBe(DAY_CREDIT.HALF);
    });

    it('reads an after-midnight arrival on a night shift as LATE, not early', () => {
        const r = evaluateShift({
            punches: [IN('2026-08-15T00:30:00Z'), OUT('2026-08-15T08:00:00Z')],
            shift: NIGHT_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        // 2.5h into a 22:00 shift. Minutes-of-day maths would call this 21.5h early.
        expect(r.latenessMinutes).toBe(150);
        expect(r.status).toBe('HALF_DAY');
    });

    it('reads a pre-midnight arrival for a 00:00 shift as early', () => {
        const midnightShift = { start: at('2026-08-15T00:00:00Z'), end: at('2026-08-15T10:00:00Z') };
        const r = evaluateShift({
            punches: [IN('2026-08-14T23:05:00Z'), OUT('2026-08-15T10:00:00Z')],
            shift: midnightShift, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.latenessMinutes).toBe(-55);   // 55 minutes EARLY
        expect(r.status).toBe('PRESENT');
    });
});

describe('HR-ATT-POLICY-01 missing punches', () => {
    it('flags MISSING_CHECKOUT once the cutoff has passed, and holds the day', () => {
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:02:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.status).toBe('MISSING_CHECKOUT');
        expect(r.dayCredit).toBeNull();          // held, not paid and not docked
        expect(r.requiresRegularization).toBe(true);
    });

    it('does NOT flag while the search window is still open', () => {
        // Shift ended 18:00, leniency 4h -> cutoff 22:00. At 19:00 the person
        // may simply still be at work.
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:02:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED,
            now: at('2026-08-14T19:00:00Z'),
        });

        expect(r.status).not.toBe('MISSING_CHECKOUT');
        expect(r.inProgress).toBe(true);
    });

    it('closes the window at the next shift when tomorrow is a working day', () => {
        const nextShiftStart = at('2026-08-15T10:00:00Z');
        const beforeNextShift = at('2026-08-15T09:00:00Z');

        const open = evaluateShift({
            punches: [IN('2026-08-14T10:02:00Z')], shift: DAY_SHIFT, policy: POLICY,
            nextDay: { working: true, nextShiftStart }, now: beforeNextShift,
        });
        const closed = evaluateShift({
            punches: [IN('2026-08-14T10:02:00Z')], shift: DAY_SHIFT, policy: POLICY,
            nextDay: { working: true, nextShiftStart }, now: nextShiftStart,
        });

        expect(open.status).not.toBe('MISSING_CHECKOUT');
        expect(closed.status).toBe('MISSING_CHECKOUT');
    });

    it('flags MISSING_CHECKIN only when the device direction is trusted', () => {
        const r = evaluateShift({
            punches: [OUT('2026-08-14T18:00:00Z')],
            shift: DAY_SHIFT,
            policy: { ...POLICY, trustDeviceDirection: true },
            nextDay: CLOSED, now: LATER,
        });

        expect(r.status).toBe('MISSING_CHECKIN');
        expect(r.dayCredit).toBeNull();
        expect(r.requiresRegularization).toBe(true);
    });

    it('reads a lone scan as an ARRIVAL by default, not a departure', () => {
        // Measured on this hardware: 462 of 1640 August sessions open with a
        // check-out code because people scan without selecting a mode. Believing
        // the code produced 417 phantom MISSING_CHECKIN. Someone who scanned once
        // came to work and forgot to leave, far more often than the reverse.
        const r = evaluateShift({
            punches: [OUT('2026-08-14T18:00:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.status).toBe('MISSING_CHECKOUT');
    });

    it('is ABSENT with no scan at all', () => {
        const r = evaluateShift({
            punches: [], shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.status).toBe('ABSENT');
        expect(r.dayCredit).toBe(DAY_CREDIT.NONE);
        expect(r.requiresRegularization).toBe(false);   // nothing to regularize yet
    });
});

describe('HR-ATT-POLICY-01 duration and precedence', () => {
    it('downgrades an on-time day that was barely worked', () => {
        // In at 10:00, out at 12:00 — 2h of an 8h shift = 25%.
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:00:00Z'), OUT('2026-08-14T12:00:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.workedPercent).toBeCloseTo(25, 0);
        expect(r.status).toBe('ABSENT');      // arrival said PRESENT; duration wins
        expect(r.dayCredit).toBe(DAY_CREDIT.NONE);
    });

    it('gives half credit in the middle band', () => {
        // 10:00 -> 15:00 = 5h of 8h = 62.5%.
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:00:00Z'), OUT('2026-08-14T15:00:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.status).toBe('HALF_DAY');
        expect(r.dayCredit).toBe(DAY_CREDIT.HALF);
    });

    it('takes the WORSE of arrival and duration, never the kinder one', () => {
        // Late (half-day by arrival) but a long shift worked (full by duration).
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:40:00Z'), OUT('2026-08-14T18:30:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.dayCredit).toBe(DAY_CREDIT.HALF);
    });

    it('measures a 3-hour shift on its own scale, not an absolute hours band', () => {
        // EMG 15:30-18:30. Three hours worked is a FULL day here; an absolute
        // "<4h = absent" rule would mark this team absent every single day.
        const shortShift = { start: at('2026-08-14T15:30:00Z'), end: at('2026-08-14T18:30:00Z') };
        const r = evaluateShift({
            punches: [IN('2026-08-14T15:30:00Z'), OUT('2026-08-14T18:30:00Z')],
            shift: shortShift, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.workedMinutes).toBe(180);
        expect(r.status).toBe('PRESENT');
        expect(r.dayCredit).toBe(DAY_CREDIT.FULL);
    });

    it('cannot downgrade a day when the employee has no rostered shift', () => {
        // The 16 roster-only employees: nothing to measure against.
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:00:00Z'), OUT('2026-08-14T12:00:00Z')],
            shift: { start: null, end: null }, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.workedPercent).toBeNull();
        expect(r.dayCredit).toBe(DAY_CREDIT.FULL);
        expect(r.status).toBe('PRESENT');
    });

    it('raises EARLY_CHECKOUT past the grace', () => {
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:00:00Z'), OUT('2026-08-14T17:00:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        const early = r.anomalies.find((a) => a.type === 'EARLY_CHECKOUT');
        expect(early?.minutesEarly).toBe(60);
    });
});

describe('HR-ATT-POLICY-01 anti-passback', () => {
    it('collapses a burst of identical scans', () => {
        // Real data: 23:05:15, :16 and :17 from one enrolment.
        const r = evaluateShift({
            punches: [
                IN('2026-08-14T10:05:15Z'), IN('2026-08-14T10:05:16Z'), IN('2026-08-14T10:05:17Z'),
                OUT('2026-08-14T18:00:00Z'),
            ],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.checkIn.toISOString()).toBe('2026-08-14T10:05:15.000Z');
        expect(r.checkOut.toISOString()).toBe('2026-08-14T18:00:00.000Z');
    });

    it('collapses a scan pair two minutes apart rather than booking a 2-minute shift', () => {
        // With direction untrusted these are indistinguishable from a double
        // scan, and a two-minute shift is not real work. Deliberate: the day
        // becomes MISSING_CHECKOUT and goes to regularization rather than
        // silently recording 2 worked minutes.
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:00:00Z'), OUT('2026-08-14T10:02:00Z')],
            shift: DAY_SHIFT, policy: POLICY, nextDay: CLOSED, now: LATER,
        });

        expect(r.checkOut).toBeNull();
        expect(r.status).toBe('MISSING_CHECKOUT');
    });

    it('keeps a close in/out pair when the device direction IS trusted', () => {
        const r = evaluateShift({
            punches: [IN('2026-08-14T10:00:00Z'), OUT('2026-08-14T10:02:00Z')],
            shift: DAY_SHIFT,
            policy: { ...POLICY, trustDeviceDirection: true },
            nextDay: CLOSED, now: LATER,
        });

        expect(r.workedMinutes).toBe(2);
    });
});

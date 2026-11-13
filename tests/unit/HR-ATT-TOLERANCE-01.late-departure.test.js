// HR-ATT-TOLERANCE-01 — leaving late must not start a new shift.
//
// A punch joins the shift in progress only if it lands within 5 hours of the
// rostered end. hamza works 15:00-00:00 and routinely leaves after midnight;
// on 8 August he scanned out at 05:06, six minutes outside the window. So the
// shift he was closing stayed open, and the scan opened a session of its own on
// a Saturday he does not work — a chargeable, payroll-blocking row.
//
// HR put it plainly: "we don't sometimes leave on time, maybe we chill or work
// without considering overtime, so these next day or deep night check-outs are
// for previous days." The window was too tight for how the place actually runs.
//
// Widening it alone would be reckless — an 8-hour close window on a day shift
// would reach into the next morning and swallow a genuine arrival. So the
// widened window applies only while it stays nearer the shift's END than to any
// plausible next start. Beyond that the punch opens a new shift, as before.
import { describe, it, expect } from '@jest/globals';
import { sessioniseByRoster } from '../../src/lib/attendanceReplay.js';

const EVENING = { type: 'weekly', offDays: [], shift: { from: '15:00', to: '00:00' } };
const DAY = { type: 'weekly', offDays: [], shift: { from: '09:00', to: '17:00' } };

const at = (iso, hhmm) => ({ punchedAt: new Date(`${iso}T${hhmm}:00.000Z`), status: 0 });
const dayOf = (s) => s.day.toISOString().slice(0, 10);
const times = (s) => s.punches.map((p) => p.timestamp.toISOString().slice(11, 16));

describe('HR-ATT-TOLERANCE-01 a late departure closes its own shift', () => {
    it('keeps hamza 14:46 -> 05:06 as ONE shift', () => {
        // His exact production data for 7-8 August.
        const sessions = sessioniseByRoster(
            [at('2026-08-07', '14:46'), at('2026-08-08', '05:06')],
            EVENING,
        );

        expect(sessions).toHaveLength(1);
        expect(dayOf(sessions[0])).toBe('2026-08-07');
        expect(times(sessions[0])).toEqual(['14:46', '05:06']);
    });

    it('does not leave a row on the Saturday he does not work', () => {
        const sessions = sessioniseByRoster(
            [at('2026-08-07', '14:46'), at('2026-08-08', '05:06')],
            EVENING,
        );

        expect(sessions.map(dayOf)).not.toContain('2026-08-08');
    });

    it('still closes a departure that is barely late', () => {
        // 02:25 — inside the old window too; must not regress.
        const sessions = sessioniseByRoster(
            [at('2026-08-06', '14:47'), at('2026-08-07', '02:25')],
            EVENING,
        );

        expect(sessions).toHaveLength(1);
    });

    it('does NOT swallow the next morning arrival on a day shift', () => {
        // 17:00 end + a wide window would reach 09:05 next morning. That is a
        // genuine arrival and has to open its own shift.
        const sessions = sessioniseByRoster(
            [at('2026-08-10', '09:02'), at('2026-08-10', '17:04'), at('2026-08-11', '09:05')],
            DAY,
        );

        expect(sessions).toHaveLength(2);
        expect(sessions.map(dayOf)).toEqual(['2026-08-10', '2026-08-11']);
    });

    it('opens a new shift for a punch nearer the next start than the last end', () => {
        // Nothing else is open; 08:58 is minutes from the 09:00 start, so it is
        // an arrival however wide the closing window is.
        const sessions = sessioniseByRoster(
            [at('2026-08-10', '09:02'), at('2026-08-11', '08:58')],
            DAY,
        );

        expect(sessions).toHaveLength(2);
    });

    it('leaves a normal two-punch day exactly as it was', () => {
        const sessions = sessioniseByRoster(
            [at('2026-08-10', '09:02'), at('2026-08-10', '17:04')],
            DAY,
        );

        expect(sessions).toHaveLength(1);
        expect(times(sessions[0])).toEqual(['09:02', '17:04']);
    });
});

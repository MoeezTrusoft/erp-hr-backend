// HR-ATT-DIRECTION-01 — the roster knows whether a lone scan is arrival or exit.
//
// Direction is decided positionally: first scan of a session is the arrival,
// last is the departure. With one scan that rule makes it an ARRIVAL, always,
// so every incomplete shift is stored MISSING_CHECKOUT.
//
// Measured against HR's August workbook, that label was wrong for 23 of the 61
// incomplete days. A single 22:15 scan against a 10:00-22:00 shift is plainly a
// departure — it is twelve hours from the start and on the minute of the end —
// and what is actually absent is the check-IN. HR's sheet agrees: their times
// for those days sit in the check-out column, matching our scan to the minute.
//
// The cost of the wrong label is not cosmetic. It sends HR to fill the wrong
// end, and filling an "out" over a scan that IS the out would overwrite the
// only real observation the day has.
//
// So a lone punch is timed against the rostered window: nearer the start makes
// it an arrival, nearer the end a departure. Sessions with two or more punches
// keep the positional rule, which is well tested and right.
import { describe, it, expect } from '@jest/globals';
import { sessioniseByRoster } from '../../src/lib/attendanceReplay.js';

const DAY = { type: 'weekly', offDays: [], shift: { from: '10:00', to: '22:00' } };
const NIGHT = { type: 'weekly', offDays: [], shift: { from: '22:00', to: '08:00' } };

const at = (iso, hhmm, status = 0) => ({
    punchedAt: new Date(`${iso}T${hhmm}:00.000Z`),
    status,
});
const types = (s) => s.punches.map((p) => p.type);

describe('HR-ATT-DIRECTION-01 direction of a lone scan', () => {
    it('reads a lone scan at the end of the shift as a DEPARTURE', () => {
        // Khurram 08-14: one scan at 22:15 against 10:00-22:00.
        const [s] = sessioniseByRoster([at('2026-08-14', '22:15')], DAY);

        expect(types(s)).toEqual(['OUT']);
    });

    it('reads a lone scan at the start of the shift as an ARRIVAL', () => {
        const [s] = sessioniseByRoster([at('2026-08-14', '10:04')], DAY);

        expect(types(s)).toEqual(['IN']);
    });

    it('keeps the positional rule when there are two scans', () => {
        const [s] = sessioniseByRoster(
            [at('2026-08-14', '10:04'), at('2026-08-14', '22:06')],
            DAY,
        );

        expect(types(s)).toEqual(['IN', 'OUT']);
    });

    it('handles a night shift, where the exit is on the next calendar day', () => {
        // Lone 08:03 scan against 22:00-08:00 — the end, not a late arrival.
        const [s] = sessioniseByRoster([at('2026-08-15', '08:03')], NIGHT);

        expect(types(s)).toEqual(['OUT']);
    });

    it('falls back to arrival when there is no roster to time it against', () => {
        // No shift, so nothing to compare to. Treating it as the arrival keeps
        // the previous behaviour for the 16 roster-less employees.
        const [s] = sessioniseByRoster([at('2026-08-14', '13:00')], {});

        expect(types(s)).toEqual(['IN']);
    });

    it('ignores the device status code, which is unreliable', () => {
        // A 22:15 scan stamped IN is still a departure — the device records
        // whatever mode the panel was left on (measured: 462 of 1640 shifts
        // opened with a check-OUT code).
        const [s] = sessioniseByRoster([at('2026-08-14', '22:15', 0)], DAY);

        expect(types(s)).toEqual(['OUT']);
    });

    it('puts a mid-shift lone scan on the nearer edge', () => {
        // 15:00 against 10:00-22:00 is 5h from the start and 7h from the end,
        // so it reads as an arrival.
        const [s] = sessioniseByRoster([at('2026-08-14', '15:00')], DAY);

        expect(types(s)).toEqual(['IN']);
    });
});

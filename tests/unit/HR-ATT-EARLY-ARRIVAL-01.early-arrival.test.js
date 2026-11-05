// HR-ATT-EARLY-ARRIVAL-01 — an arrival earlier than the check-in window is not
// the previous day's departure.
//
// Observed on production, Abdullah Hanif (Trusoft, 22:00-07:00):
//
//   11-02  in=null  out=11-03 16:17   MISSING_CHECKIN   (the scan is an ARRIVAL)
//   11-03  in=null  out=11-04 08:22   MISSING_CHECKIN   (its real check-out)
//
// The 2 Nov shift closed at 07:00 on 3 Nov, and its check-out window runs until
// the next shift's check-in window opens (22:00 - 5h = 17:00). A crew arriving
// 5h43 early therefore landed inside the PREVIOUS shift's close window, was
// repaired to that shift's check-out, and left both its own day and the next
// day incomplete.
//
// The rule added: an IN punch that is nearer a rostered START than the END it
// would otherwise close belongs to that start. A chosen check-out (device OUT)
// is untouched — it closes the shift it belongs to.
import { describe, it, expect } from '@jest/globals';
import { sessioniseByRoster } from '../../src/lib/attendanceReplay.js';

const NIGHT = { type: 'weekly', shift: { from: '22:00', to: '07:00' }, offDays: [] };

const at = (iso, hhmm) => new Date(`${iso}T${hhmm}:00.000Z`);
const dayOf = (s) => s.day.toISOString().slice(0, 10);
const times = (s) => s.punches.map((p) => p.timestamp.toISOString().slice(11, 16));

describe('HR-ATT-EARLY-ARRIVAL-01 an early arrival belongs to the start it is near', () => {
    it('keeps the 3 Nov 16:17 arrival and its 4 Nov 08:22 departure on 3 Nov', () => {
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-11-03', '16:17'), status: 0 },
                { punchedAt: at('2026-11-04', '08:22'), status: 1 },
            ],
            NIGHT,
        );

        expect(sessions).toHaveLength(1);
        expect(dayOf(sessions[0])).toBe('2026-11-03');
        expect(times(sessions[0])).toEqual(['16:17', '08:22']);
    });

    it('does not give the 3 Nov arrival to an earlier shift that has its own arrival', () => {
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-11-02', '21:56'), status: 0 },
                { punchedAt: at('2026-11-03', '16:17'), status: 0 },
                { punchedAt: at('2026-11-04', '08:22'), status: 1 },
            ],
            NIGHT,
        );

        expect(sessions.map(dayOf)).toEqual(['2026-11-02', '2026-11-03']);
        expect(times(sessions[0])).toEqual(['21:56']);
        expect(times(sessions[1])).toEqual(['16:17', '08:22']);
    });

    it('still closes the previous shift with a chosen check-out past the window', () => {
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-11-02', '21:56'), status: 0 },
                { punchedAt: at('2026-11-03', '16:17'), status: 1 },
            ],
            NIGHT,
        );

        expect(sessions).toHaveLength(1);
        expect(dayOf(sessions[0])).toBe('2026-11-02');
        expect(times(sessions[0])).toEqual(['21:56', '16:17']);
    });

    it('keeps a near-the-end check-out on its own night (no regression)', () => {
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-11-02', '22:00'), status: 0 },
                { punchedAt: at('2026-11-03', '08:30'), status: 1 },
            ],
            NIGHT,
        );

        expect(sessions).toHaveLength(1);
        expect(dayOf(sessions[0])).toBe('2026-11-02');
        expect(times(sessions[0])).toEqual(['22:00', '08:30']);
    });

    it('leaves a genuine day-shift arrival with the shift it follows', () => {
        // A 09:00 day shift after a 22:00-07:00 night: an 08:30 scan is one hour
        // after the night's end and 30 minutes before the day shift's start, so
        // the night keeps it (nearer END, not nearer START).
        const roster = {
            type: 'rotating',
            rotatingShifts: [
                { from: '22:00', to: '07:00' },
                { from: '09:00', to: '21:00' },
            ],
        };
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-11-02', '21:58'), status: 0 },
                { punchedAt: at('2026-11-03', '08:30'), status: 0 },
            ],
            roster,
        );

        expect(dayOf(sessions[0])).toBe('2026-11-02');
        expect(times(sessions[0])).toEqual(['21:58', '08:30']);
    });
});

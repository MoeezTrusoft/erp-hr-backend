// HR-ATT-DUPLICATE-01 — pressing the reader twice is one scan, not two shifts.
//
// The MB460 records every press. Khurram's device repeats each one three times:
//
//   2026-08-12 22:05 IN   x3
//   2026-08-13 10:11 OUT  x3
//
// That is one night shift. What the sessioniser made of it was two: the FIRST
// 10:11 closes the shift opened at 22:05 and clears `open` — correct — and then
// the second and third 10:11 punches find nothing open, so each is treated as an
// arrival and opens a fresh session on 08-13.
//
// 08-13 is Khurram's rotation rest day. The invented session holds a single
// punch, so it evaluates to MISSING_CHECKOUT, or to ABSENT once several
// same-instant scans collapse to zero worked minutes. Either way it is a
// chargeable row on a day the roster says he was off, and it regenerates every
// time the evaluator runs — deleting the rows does not help while the punches
// still produce them.
//
// This is not confined to the rotation. Any employee whose device double-taps
// gets a phantom arrival after every genuine departure, which is where the
// month's MISSING_CHECKOUT count comes from: Zubair 6, Sameer 5, Usman 4.
//
// So repeated scans within a short window collapse to the first. The window is
// deliberately small (2 minutes): it must swallow a double-tap and the
// 22:02/22:03 straddle of a slow finger, and must not swallow two genuine
// events, which on a 12-hour roster are hours apart.
import { describe, it, expect } from '@jest/globals';
import { sessioniseByRoster } from '../../src/lib/attendanceReplay.js';

const ROTATING = {
    type: 'rotating',
    rotatingShifts: [
        { from: '10:00', to: '22:00' },
        { from: '22:00', to: '10:00' },
    ],
};

const at = (iso, hhmm) => new Date(`${iso}T${hhmm}:00.000Z`);
const dayOf = (s) => s.day.toISOString().slice(0, 10);
const times = (s) => s.punches.map((p) => p.timestamp.toISOString().slice(11, 16));

describe('HR-ATT-DUPLICATE-01 repeated scans', () => {
    it('does not let a repeated closing scan open a shift on the rest day', () => {
        // Khurram's exact production data for 12-13 August.
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-12', '22:05'), status: 0 },
                { punchedAt: at('2026-08-12', '22:05'), status: 0 },
                { punchedAt: at('2026-08-12', '22:05'), status: 0 },
                { punchedAt: at('2026-08-13', '10:11'), status: 1 },
                { punchedAt: at('2026-08-13', '10:11'), status: 1 },
                { punchedAt: at('2026-08-13', '10:11'), status: 1 },
            ],
            ROTATING,
        );

        expect(sessions.map(dayOf)).toEqual(['2026-08-12']);
        expect(times(sessions[0])).toEqual(['22:05', '10:11']);
    });

    it('collapses a scan repeated a minute later', () => {
        // 22:02, 22:02, 22:03 — one slow press, three records.
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-08', '10:13'), status: 0 },
                { punchedAt: at('2026-08-08', '22:02'), status: 1 },
                { punchedAt: at('2026-08-08', '22:02'), status: 1 },
                { punchedAt: at('2026-08-08', '22:03'), status: 1 },
            ],
            ROTATING,
        );

        expect(sessions).toHaveLength(1);
        expect(times(sessions[0])).toEqual(['10:13', '22:02']);
    });

    it('keeps two genuine events that are hours apart', () => {
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-15', '10:16'), status: 0 },
                { punchedAt: at('2026-08-15', '22:04'), status: 1 },
            ],
            ROTATING,
        );

        expect(times(sessions[0])).toEqual(['10:16', '22:04']);
    });

    it('does not collapse punches ten minutes apart', () => {
        // Well outside the window: a real second event, kept.
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-15', '10:16'), status: 0 },
                { punchedAt: at('2026-08-15', '10:26'), status: 1 },
            ],
            ROTATING,
        );

        expect(times(sessions[0])).toEqual(['10:16', '10:26']);
    });

    it('leaves a genuinely worked rest day intact', () => {
        // A complete pair on a rest day is real work and must survive; only the
        // phantom re-opening is being removed.
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-13', '10:04'), status: 0 },
                { punchedAt: at('2026-08-13', '10:04'), status: 0 },
                { punchedAt: at('2026-08-13', '22:06'), status: 1 },
            ],
            ROTATING,
        );

        expect(sessions).toHaveLength(1);
        expect(dayOf(sessions[0])).toBe('2026-08-13');
        expect(times(sessions[0])).toEqual(['10:04', '22:06']);
    });

    it('collapses a four-fold repeat to a single lone punch', () => {
        // Khurram 08-14: 22:15 recorded four times. One scan, so one incomplete
        // shift for HR to regularise -- not four.
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-14', '22:15'), status: 1 },
                { punchedAt: at('2026-08-14', '22:15'), status: 1 },
                { punchedAt: at('2026-08-14', '22:15'), status: 1 },
                { punchedAt: at('2026-08-14', '22:15'), status: 1 },
            ],
            ROTATING,
        );

        expect(sessions).toHaveLength(1);
        expect(times(sessions[0])).toEqual(['22:15']);
    });
});

// HR-ATT-SESSION-01 — a night shift's closing scan is not the next day's arrival.
//
// Observed on production, S. Wajahat Ali:
//
//   08-01  in=22:14  out=10:02     the night shift, correct
//   08-02  in=10:02  out=10:02     the SAME punch, reused as an arrival
//
// and Ghulam Rasool:
//
//   08-06  in=21:57  out=11:27
//   08-07  in=11:27  out=null      -> MISSING_CHECKOUT
//
// sessioniseByRoster scores each punch independently against the nearest shift
// edge. For a rotating roster the night shift ENDS at 10:00 and the next day
// shift STARTS at 10:00, so a 10:02 scan is two minutes from both. Independent
// scoring cannot break that tie — whichever edge it picks, it is guessing.
//
// The domain does break it: you cannot arrive while you are still on shift. So
// a punch that could close an OPEN shift closes it, and only a punch that
// cannot goes on to open a new one.
//
// The cost of getting it wrong is not cosmetic. It manufactures a zero-length
// day, a MISSING_CHECKOUT that never happened, and an attendance row on a
// rotation rest day — and each of those is chargeable against somebody's pay.
import { describe, it, expect } from '@jest/globals';
import { sessioniseByRoster } from '../../src/lib/attendanceReplay.js';

const ROTATING = {
    type: 'rotating',
    rotatingShifts: [
        { from: '10:00', to: '22:00' },
        { from: '22:00', to: '10:00' },
    ],
};
const FIXED_NIGHT = { type: 'weekly', shift: { from: '22:00', to: '08:00' } };

const at = (iso, hhmm) => new Date(`${iso}T${hhmm}:00.000Z`);
const dayOf = (s) => s.day.toISOString().slice(0, 10);
const times = (s) => s.punches.map((p) => p.timestamp.toISOString().slice(11, 16));

describe('HR-ATT-SESSION-01 closing beats opening', () => {
    it('keeps a 22:14 -> 10:02 night shift as ONE session', () => {
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-01', '22:14'), status: 0 },
                { punchedAt: at('2026-08-02', '10:02'), status: 1 },
            ],
            ROTATING,
        );

        expect(sessions).toHaveLength(1);
        expect(dayOf(sessions[0])).toBe('2026-08-01');
        expect(times(sessions[0])).toEqual(['22:14', '10:02']);
    });

    it('does not reuse the closing scan as the next day arrival', () => {
        // The exact production shape: the closing scan must not resurrect 08-02
        // as a zero-length day.
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-01', '22:14'), status: 0 },
                { punchedAt: at('2026-08-02', '10:02'), status: 1 },
            ],
            ROTATING,
        );

        expect(sessions.map(dayOf)).not.toContain('2026-08-02');
    });

    it('still opens a NEW session for a genuine 10:00 day-shift arrival', () => {
        // Nothing is open here, so 10:04 is an arrival and must stay one.
        // The guard must not swallow real day shifts.
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-02', '10:04'), status: 0 },
                { punchedAt: at('2026-08-02', '22:06'), status: 1 },
            ],
            ROTATING,
        );

        expect(sessions).toHaveLength(1);
        expect(dayOf(sessions[0])).toBe('2026-08-02');
        expect(times(sessions[0])).toEqual(['10:04', '22:06']);
    });

    it('handles night, then a day shift the following morning', () => {
        // 22:14 -> 10:02 closes the night; 10:40 is past the close and is a real
        // arrival, closed by 22:05.
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-01', '22:14'), status: 0 },
                { punchedAt: at('2026-08-02', '10:02'), status: 1 },
                { punchedAt: at('2026-08-02', '10:40'), status: 0 },
                { punchedAt: at('2026-08-02', '22:05'), status: 1 },
            ],
            ROTATING,
        );

        expect(sessions).toHaveLength(2);
        expect(sessions.map(dayOf)).toEqual(['2026-08-01', '2026-08-02']);
        expect(times(sessions[0])).toEqual(['22:14', '10:02']);
        expect(times(sessions[1])).toEqual(['10:40', '22:05']);
    });

    it('does not strand the morning scan of a FIXED night roster either', () => {
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-01', '21:58'), status: 0 },
                { punchedAt: at('2026-08-02', '08:03'), status: 1 },
            ],
            FIXED_NIGHT,
        );

        expect(sessions).toHaveLength(1);
        expect(dayOf(sessions[0])).toBe('2026-08-01');
    });

    it('ignores the device direction code, which is unreliable', () => {
        // Ghulam Rasool's 11:27 closing scan is stamped IN (status 0). The
        // module already documents that people press the wrong key; position
        // decides, so a mis-stamped close must still close.
        const sessions = sessioniseByRoster(
            [
                { punchedAt: at('2026-08-06', '21:57'), status: 0 },
                { punchedAt: at('2026-08-07', '11:27'), status: 0 }, // says IN, is OUT
            ],
            ROTATING,
        );

        expect(sessions).toHaveLength(1);
        expect(dayOf(sessions[0])).toBe('2026-08-06');
    });

    it('leaves a lone morning scan as its own session rather than dropping it', () => {
        // Nothing open to close, so it stands alone and the evaluator can call
        // it incomplete. Silently discarding a punch would be worse.
        const sessions = sessioniseByRoster(
            [{ punchedAt: at('2026-08-10', '10:46'), status: 1 }],
            ROTATING,
        );

        expect(sessions).toHaveLength(1);
        expect(times(sessions[0])).toEqual(['10:46']);
    });
});

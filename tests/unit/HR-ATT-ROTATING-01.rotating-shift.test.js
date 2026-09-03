// HR-ATT-ROTATING-01 — employees whose shift alternates day/night.
//
// Seven EMG staff work "10am/pm – 10am/pm": a 12-hour shift that flips between
// a 10:00 start and a 22:00 start, two days on then rotating. Their workbook
// rows carry no single shift time because there isn't one.
//
// With no shift on file the evaluator fell back to the 09:00 default, so every
// night start read as thirteen hours late:
//
//   G Rasool   D02 N03 D05 N06 D08 N09 D11 N12
//   Khurram    D02 N03 D05 N06 D08 N09 D11 N12
//   Wajahat    N01 D03 D06 N07 D09 N10 D12 N13
//
// The punch itself says which shift it is — check-ins cluster tightly at ~10:00
// or ~22:00 and nowhere between. So the roster carries BOTH windows and the
// nearest one to the actual arrival wins. No external anchor is needed, which
// matters because nobody could tell us who started on days on 1 August.
import { describe, it, expect } from '@jest/globals';
import { shiftFor, sessioniseByRoster } from '../../src/lib/attendanceReplay.js';

const ROTATING = {
    type: 'rotating',
    rotatingShifts: [
        { from: '10:00', to: '22:00' },
        { from: '22:00', to: '10:00' },
    ],
};
const FIXED = { type: 'weekly', shift: { from: '10:00', to: '18:00' } };

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const at = (iso, hhmm) => new Date(`${iso}T${hhmm}:00.000Z`);

describe('HR-ATT-ROTATING-01 shiftFor picks the window nearest the arrival', () => {
    it('reads a 10:0x arrival as the DAY shift', () => {
        const s = shiftFor(ROTATING, day('2026-08-02'), at('2026-08-02', '10:06'));
        expect(s.start.getUTCHours()).toBe(10);
    });

    it('reads a 22:0x arrival as the NIGHT shift, not a late day start', () => {
        // This is the whole defect: 22:03 against a 10:00 start is "12h late".
        const s = shiftFor(ROTATING, day('2026-08-03'), at('2026-08-03', '22:03'));
        expect(s.start.getUTCHours()).toBe(22);
    });

    it('rolls the night shift end into the following morning', () => {
        const s = shiftFor(ROTATING, day('2026-08-03'), at('2026-08-03', '22:03'));
        expect(s.end.getTime()).toBeGreaterThan(s.start.getTime());
        expect(s.end.getUTCHours()).toBe(10);
    });

    it('falls back to the first window when there is no punch to anchor on', () => {
        // Used for tomorrow's checkout cutoff, where no arrival exists yet.
        const s = shiftFor(ROTATING, day('2026-08-04'));
        expect(s.start.getUTCHours()).toBe(10);
    });

    it('leaves a fixed roster exactly as it was', () => {
        const s = shiftFor(FIXED, day('2026-08-02'), at('2026-08-02', '21:00'));
        expect(s.start.getUTCHours()).toBe(10);
        expect(s.end.getUTCHours()).toBe(18);
    });
});

describe('HR-ATT-ROTATING-01 sessionisation keeps a night shift on one day', () => {
    it('groups a 22:00 arrival with its 10:00 departure the next morning', () => {
        const punches = [
            { punchedAt: at('2026-08-03', '22:03'), status: 0 },
            { punchedAt: at('2026-08-04', '10:00'), status: 1 },
        ];

        const sessions = sessioniseByRoster(punches, ROTATING);

        expect(sessions).toHaveLength(1);
        expect(sessions[0].punches).toHaveLength(2);
    });

    it('keeps a day shift and the following night shift apart', () => {
        const punches = [
            { punchedAt: at('2026-08-02', '10:00'), status: 0 },
            { punchedAt: at('2026-08-02', '22:03'), status: 1 },
            { punchedAt: at('2026-08-03', '22:04'), status: 0 },
            { punchedAt: at('2026-08-04', '10:11'), status: 1 },
        ];

        const sessions = sessioniseByRoster(punches, ROTATING);

        expect(sessions).toHaveLength(2);
        expect(sessions.every((s) => s.punches.length === 2)).toBe(true);
    });
});

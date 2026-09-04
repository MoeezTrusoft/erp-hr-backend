// HR-ATT-ROTATING-03 — the rotation phase, recovered from HR's own roster.
//
// HR-ATT-ROTATING-02 suppressed absence marking for rotating staff because the
// rotation had no anchor on file: nobody could say who was on days on 1 August,
// so a day with no punch could not be told apart from a rest day.
//
// HR's final August workbook turns out to carry exactly that anchor. Their
// "weekly off" colour, read per employee, lands on a clean 3-day cycle — every
// one of the six has ONE residue mod 3 and no other:
//
//   G Rasool, Khurram    off 01 04 07 10 13 16 19 22 25 28 31   phase 0
//   Wajahat              off 02 05 08 11 14 17 20 23 26 29      phase 1
//   Asad, Imran H,       off 03 06 09 12 15 18 21 24 27 30      phase 2
//   M. Imran
//
// which is precisely the "2 days on, 1 off" the operator described. So the
// phase is knowable after all, and a known phase is strictly better than
// suppression: the rest day becomes a real OFF_DAY and a genuine no-show on a
// working day is charged again.
//
// `offDays` cannot express this — it is a weekday list, and a 3-day cycle walks
// through the week. Hence `cycle`.
//
// Where the phase is NOT known (M. Zubair is on no grid in the workbook) the
// roster stays cycle-less and ROTATING-02's suppression still applies.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const SCHEDULE = { schedule_pattern: null };
const prismaMock = {
    workSchedule: { findFirst: jest.fn(async () => SCHEDULE) },
    employeeHolidayCalendar: { findMany: jest.fn(async () => []) },
    holiday: { findMany: jest.fn(async () => []) },
    leave: { findMany: jest.fn(async () => []) },
};
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { resolveWorkingDays } = await import('../../src/services/workingDay.service.js');

const ROTATING = (offIndex) => ({
    type: 'rotating',
    rotatingShifts: [{ from: '10:00', to: '22:00' }, { from: '22:00', to: '10:00' }],
    offDays: [],
    cycle: { days: 3, offIndex, anchor: '2026-08-01' },
});
const NO_PHASE = {
    type: 'rotating',
    rotatingShifts: [{ from: '10:00', to: '22:00' }, { from: '22:00', to: '10:00' }],
    offDays: [],
};

const resolve = async (pattern) => {
    SCHEDULE.schedule_pattern = pattern;
    return resolveWorkingDays({ employeeId: 1, from: '2026-08-01', to: '2026-08-10' });
};
const offDaysIn = (map) =>
    [...map.entries()].filter(([, v]) => !v.working).map(([k]) => Number(k.slice(8)));

beforeEach(() => jest.clearAllMocks());

describe('HR-ATT-ROTATING-03 rotation phase', () => {
    it('rests G Rasool and Khurram on 1, 4, 7, 10 August (phase 0)', async () => {
        expect(offDaysIn(await resolve(ROTATING(0)))).toEqual([1, 4, 7, 10]);
    });

    it('rests Wajahat on 2, 5, 8 August (phase 1)', async () => {
        expect(offDaysIn(await resolve(ROTATING(1)))).toEqual([2, 5, 8]);
    });

    it('rests Asad, Imran H and M. Imran on 3, 6, 9 August (phase 2)', async () => {
        expect(offDaysIn(await resolve(ROTATING(2)))).toEqual([3, 6, 9]);
    });

    it('labels the rest day ROTATION_OFF, not a weekday off', async () => {
        const map = await resolve(ROTATING(0));
        expect(map.get('2026-08-04')).toMatchObject({ working: false, reason: 'ROTATION_OFF' });
    });

    it('works the other two days of every cycle', async () => {
        const map = await resolve(ROTATING(0));
        expect(map.get('2026-08-02').working).toBe(true);
        expect(map.get('2026-08-03').working).toBe(true);
    });

    it('stops flagging `rotating` once the phase is known', async () => {
        // The ROTATING-02 suppression is a fallback for an UNKNOWN phase. With
        // the phase known, a no-show on a working day must be chargeable again.
        const map = await resolve(ROTATING(0));
        expect(map.get('2026-08-02').rotating).toBeFalsy();
    });

    it('still flags `rotating` when no phase is on file', async () => {
        const map = await resolve(NO_PHASE);
        expect(map.get('2026-08-02')).toMatchObject({ working: true, rotating: true });
        expect(offDaysIn(map)).toEqual([]);
    });

    it('handles a day before the anchor without drifting the phase', async () => {
        // A negative day difference must not make the modulo negative — 29 July
        // is a rest day on phase 0 and 30/31 July are not.
        SCHEDULE.schedule_pattern = ROTATING(0);
        const map = await resolveWorkingDays({ employeeId: 1, from: '2026-07-29', to: '2026-07-31' });
        expect([...map.entries()].filter(([, v]) => !v.working).map(([k]) => k))
            .toEqual(['2026-07-29']);
    });
});

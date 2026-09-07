// HR-ROSTER-01 — the schedule in force on a DAY, not on a query.
//
// resolveWorkingDays already carries the right intention in a comment:
//
//     Effective-dated: off-days can change mid-month for one employee, and the
//     old pattern must keep applying to the days it covered.
//
// The query underneath it does not do that. It is a findFirst ordered by
// effective_start_date desc, so ONE schedule — the newest that overlaps the
// window — is applied to every day in the range. replayTenant reads schedules
// the same way.
//
// Nothing is visibly broken today only because all 75 employees have exactly
// one schedule row. The moment a second exists, the new pattern is applied
// backwards over days the old one covered: change somebody's weekend today and
// last month's Saturdays silently become working days, which turns reconciled
// attendance into absences and absences into pay.
//
// That matters right now — four Homenet rosters are about to be corrected with
// effect from 1 August, and more will follow as HR keeps refining them. A
// roster change must never be able to rewrite a month that was already closed.
//
// So: resolve per day. Each date takes the schedule whose effective range
// contains it; days before any schedule starts have none.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const EMPLOYEE = 501;
const d = (iso) => new Date(`${iso}T00:00:00.000Z`);

// Two versions of one roster: Sat+Sun off until 15 August, Tue+Fri off after.
const SCHEDULES = [
    {
        effective_start_date: d('2026-08-16'),
        effective_end_date: null,
        schedule_pattern: { offDays: [2, 5], shift: { from: '09:00', to: '18:00' } },
    },
    {
        effective_start_date: d('2026-08-01'),
        effective_end_date: d('2026-08-15'),
        schedule_pattern: { offDays: [6, 7], shift: { from: '09:00', to: '18:00' } },
    },
];

const overlapping = (where) => {
    const lte = where?.effective_start_date?.lte;
    const gte = where?.OR?.[1]?.effective_end_date?.gte;
    return SCHEDULES.filter((s) =>
        (!lte || s.effective_start_date <= lte)
        && (!gte || s.effective_end_date === null || s.effective_end_date >= gte));
};

const prismaMock = {
    workSchedule: {
        findFirst: jest.fn(async ({ where }) => {
            const hits = [...overlapping(where)]
                .sort((a, b) => b.effective_start_date - a.effective_start_date);
            return hits[0] ?? null;
        }),
        findMany: jest.fn(async ({ where }) => overlapping(where)),
    },
    employeeHolidayCalendar: { findMany: jest.fn(async () => []) },
    holiday: { findMany: jest.fn(async () => []) },
    leave: { findMany: jest.fn(async () => []) },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { resolveWorkingDays } = await import('../../src/services/workingDay.service.js');

beforeEach(() => jest.clearAllMocks());

const run = () => resolveWorkingDays({
    employeeId: EMPLOYEE, from: '2026-08-01', to: '2026-08-31',
});

describe('HR-ROSTER-01 schedule resolved per day', () => {
    it('applies the OLD pattern to days before the change', async () => {
        const days = await run();

        // 08-08 and 08-09 are Sat/Sun — off under the pattern in force then.
        expect(days.get('2026-08-08')?.working).toBe(false);
        expect(days.get('2026-08-09')?.working).toBe(false);
    });

    it('applies the NEW pattern to days after the change', async () => {
        const days = await run();

        // 08-18 is a Tuesday and 08-21 a Friday — off under the new pattern.
        expect(days.get('2026-08-18')?.working).toBe(false);
        expect(days.get('2026-08-21')?.working).toBe(false);
    });

    it('does not apply the new pattern backwards', async () => {
        const days = await run();

        // 08-04 is a Tuesday and 08-07 a Friday. Under the OLD pattern they were
        // ordinary working days, and a roster changed on the 16th must not
        // reach back and turn them into rest days.
        expect(days.get('2026-08-04')?.working).toBe(true);
        expect(days.get('2026-08-07')?.working).toBe(true);
    });

    it('does not apply the old pattern forwards', async () => {
        const days = await run();

        // 08-22 and 08-23 are Sat/Sun, working days under the new pattern.
        expect(days.get('2026-08-22')?.working).toBe(true);
        expect(days.get('2026-08-23')?.working).toBe(true);
    });

    it('reads every schedule covering the window, not just the newest', async () => {
        await run();

        expect(prismaMock.workSchedule.findMany.mock.calls.length).toBeGreaterThan(0);
    });
});

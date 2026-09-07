// HR-RECON-02 — the HR graphs must stop assuming everyone works Mon-Sat.
//
// timesheetReport had the assumption twice, hardcoded:
//
//   isWorkingDay()   dow 1..6, so Sunday is the only non-working day
//   weekly graph     expectedDays = totalEmployees * countWorkingDays(week)
//   absenteeism      emits only Mon-Sat, denominator = ALL employees
//
// The roster work disproved it outright. Real rosters in this fleet are Tue+Fri
// (8 people), Mon+Wed (4), Tue+Thu (4), Fri+Sat (2), Sat+Mon (1), Tue+Wed+Thu
// (2) and 3-day rotations that walk through the week. Sunday is a working day
// for the whole night-shift population.
//
// Both errors point the same way and both flatter the numbers. Counting a
// Sunday shift against a denominator that excludes Sundays inflates
// attendance; counting somebody's rostered day off in the absenteeism
// denominator dilutes it. Nobody would notice either from the graph.
//
// The denominator is now DERIVED from what the day actually was
// (HR-ATT-STATUS-01): expected = rows that are not WEEKLY_OFF, HOLIDAY or
// ON_LEAVE. That is the same rule the reconciliation report uses, so the graph
// and the report cannot disagree.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

let rows;

const prismaMock = {
    employee: { count: jest.fn(async () => 2) },
    attendance: {
        findMany: jest.fn(async ({ where }) => {
            // Mirrors the real client: honour a status filter if one is given,
            // so a query that over-fetches or under-fetches shows up here.
            const want = where?.status?.in ?? (where?.status ? [where.status] : null);
            return want ? rows.filter((r) => want.includes(r.status)) : rows;
        }),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/tenancy.js', () => ({
    scopedWhere: (_t, w) => w,
    scopedEmployeeWhere: (_t, w) => w,
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { getAttendanceSummaryWeekly, getAbsenteeismTrend } = await import(
    '../../src/services/timesheetReport.service.js'
);

// 2026-08-02 is a Sunday, 2026-08-03 a Monday.
const row = (employeeId, date, status) => ({
    employeeId, date: new Date(`${date}T00:00:00.000Z`), status,
});

beforeEach(() => { jest.clearAllMocks(); rows = []; });

describe('HR-RECON-02 denominators derived from the roster', () => {
    it('counts a Sunday shift, instead of ignoring the day', async () => {
        // A night-shift worker rostered on Sunday, present. Under the old rule
        // the day was not "working", so the shift counted in the numerator with
        // no matching denominator.
        rows = [row(1, '2026-08-02', 'PRESENT')];

        const { weeks } = await getAttendanceSummaryWeekly({ tenantId: 't', month: '2026-08' });
        const week = weeks.find((w) => w.attendancePct > 0);

        expect(week.attendancePct).toBe(100);
    });

    it('does not count a rostered day off as an expected day', async () => {
        // One worked, one was off. 1 of 1 expected, not 1 of 2.
        rows = [row(1, '2026-08-03', 'PRESENT'), row(2, '2026-08-03', 'WEEKLY_OFF')];

        const { weeks } = await getAttendanceSummaryWeekly({ tenantId: 't', month: '2026-08' });
        const week = weeks.find((w) => w.attendancePct > 0);

        expect(week.attendancePct).toBe(100);
    });

    it('counts a holiday and approved leave out of the denominator too', async () => {
        rows = [
            row(1, '2026-08-03', 'PRESENT'),
            row(2, '2026-08-03', 'HOLIDAY'),
            row(1, '2026-08-04', 'ON_LEAVE'),
        ];

        const { weeks } = await getAttendanceSummaryWeekly({ tenantId: 't', month: '2026-08' });
        const week = weeks.find((w) => w.attendancePct > 0);

        expect(week.attendancePct).toBe(100);
    });

    it('still reports a real shortfall', async () => {
        // Two expected, one turned up.
        rows = [row(1, '2026-08-03', 'PRESENT'), row(2, '2026-08-03', 'ABSENT')];

        const { weeks } = await getAttendanceSummaryWeekly({ tenantId: 't', month: '2026-08' });
        const week = weeks.find((w) => w.attendancePct > 0);

        expect(week.attendancePct).toBe(50);
    });

    it('absenteeism is measured against who was ROSTERED that day', async () => {
        // One absent, one on their weekly off. 1 of 1 rostered, not 1 of 2
        // employees — counting the day off in the denominator halves it.
        rows = [row(1, '2026-08-03', 'ABSENT'), row(2, '2026-08-03', 'WEEKLY_OFF')];

        const { days } = await getAbsenteeismTrend({ tenantId: 't', month: '2026-08' });
        const day = days.find((d) => d.date === '2026-08-03');

        expect(day.absenteeismPct).toBe(100);
    });

    it('absenteeism includes Sunday when somebody was rostered on it', async () => {
        rows = [row(1, '2026-08-02', 'ABSENT'), row(2, '2026-08-02', 'PRESENT')];

        const { days } = await getAbsenteeismTrend({ tenantId: 't', month: '2026-08' });

        expect(days.map((d) => d.date)).toContain('2026-08-02');
        expect(days.find((d) => d.date === '2026-08-02').absenteeismPct).toBe(50);
    });

    it('omits a day nobody was rostered on, rather than showing 0%', async () => {
        // A day where everyone is off is not 0% absenteeism, it is not a data
        // point at all. Plotting it as 0 implies a perfect day nobody worked.
        rows = [row(1, '2026-08-03', 'WEEKLY_OFF'), row(2, '2026-08-03', 'WEEKLY_OFF')];

        const { days } = await getAbsenteeismTrend({ tenantId: 't', month: '2026-08' });

        expect(days.map((d) => d.date)).not.toContain('2026-08-03');
    });

    it('never divides by zero', async () => {
        rows = [];

        const { weeks } = await getAttendanceSummaryWeekly({ tenantId: 't', month: '2026-08' });

        expect(weeks.every((w) => w.attendancePct === 0)).toBe(true);
    });
});

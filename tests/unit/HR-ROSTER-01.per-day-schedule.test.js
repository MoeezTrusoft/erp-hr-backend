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

const prismaMock={
 attendanceSetupRelease:{findMany:jest.fn(async()=>[{version:1,effectiveFrom:'2026-08-01',coverageThrough:'2026-08-31',config:{version:1,settings:{defaultCalendarId:1},policy:{},employees:[{id:EMPLOYEE,status:'active'}],periods:[],schedules:SCHEDULES.map(s=>({...s,employeeId:EMPLOYEE})),calendars:[{id:1}],holidays:[],calendarAssignments:[]}}])},
 shiftAssignment:{findMany:jest.fn(async()=>[])},leaveRequest:{findMany:jest.fn(async()=>[])},leave:{findMany:jest.fn(async()=>[])},attendanceCallIn:{findMany:jest.fn(async()=>[])}
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { resolveWorkingDays } = await import('../../src/services/workingDay.service.js');

beforeEach(() => jest.clearAllMocks());

const run = () => resolveWorkingDays({
    tenantId:'tenant-a',employeeId: EMPLOYEE, from: '2026-08-01', to: '2026-08-31',
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

    it('reads published versions covering the window', async () => {
        await run();

        expect(prismaMock.attendanceSetupRelease.findMany.mock.calls.length).toBeGreaterThan(0);
    });
});

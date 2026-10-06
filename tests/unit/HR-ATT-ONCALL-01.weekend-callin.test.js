// HR-ATT-ONCALL-01 — weekend on-call.
//
// HR rings an employee in for ONE date (operator ruling 2026-10-05: HR records
// the call-in; a no-show is ABSENT + immediate deduction, no anomaly form).
// That means two behaviours have to hold together:
//
//   1. workingDay gives the date precedence over BOTH rest rules (weekday off
//      and rotation rest) — but approved leave still outranks it; and
//   2. absence marking must restate the STALE WEEKLY_OFF row the roster wrote
//      for that date into ABSENT. Without (2) the no-show would be skipped by
//      guard 3 ("row exists") and never charged — the whole point of the flow.
//
// The real resolveWorkingDays runs against the mocked prisma here, so the two
// halves are proven against each other rather than in isolation.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const ENROLLED = { id: 1, employee_code: 'EMP001', biometric_id: '3001' };

let schedules, leaves, callIns, attendanceRows, created, updated;

const prismaMock = {
    workSchedule: { findMany: jest.fn(async () => schedules) },
    employeeHolidayCalendar: { findMany: jest.fn(async () => []) },
    holiday: { findMany: jest.fn(async () => []) },
    leave: { findMany: jest.fn(async () => leaves) },
    attendanceCallIn: { findMany: jest.fn(async () => callIns) },
    employee: {
        findMany: jest.fn(async () => [ENROLLED]),
        count: jest.fn(async () => 0),
    },
    employmentPeriod: { findMany: jest.fn(async () => []) },
    attendance: {
        findMany: jest.fn(async () => attendanceRows),
        create: jest.fn(async ({ data }) => { created.push(data); return { id: created.length, ...data }; }),
        update: jest.fn(async ({ where, data }) => { updated.push({ where, data }); return { id: where.id, ...data }; }),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_c, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { resolveWorkingDays } = await import('../../src/services/workingDay.service.js');
const svc = await import('../../src/services/absenceMarking.service.js');

const WEEKLY_OFF_SUNDAY = {
    schedule_pattern: {
        type: 'weekly',
        shift: { from: '10:00', to: '22:00' },
        offDays: [7], // Sunday
        shiftHours: 12,
    },
    effective_start_date: new Date('2020-01-01T00:00:00.000Z'),
    effective_end_date: null,
};
// 2026-08-02 is a Sunday.
const SUNDAY = '2026-08-02';
const day = (s) => { const d = new Date(`${s}T00:00:00.000Z`); return d; };

beforeEach(() => {
    jest.clearAllMocks();
    schedules = [{ ...WEEKLY_OFF_SUNDAY }];
    leaves = [];
    callIns = [];
    attendanceRows = [];
    created = [];
    updated = [];
});

describe('HR-ATT-ONCALL-01 working-day resolution', () => {
    it('a Sunday with no call-in is a rostered day off', async () => {
        const map = await resolveWorkingDays({ employeeId: 1, tenantId: TENANT, from: SUNDAY, to: SUNDAY });
        expect(map.get(SUNDAY)).toMatchObject({ working: false, reason: 'OFF_DAY' });
    });

    it('a call-in makes that Sunday a working day', async () => {
        callIns = [{ date: day(SUNDAY), reason: 'weekend site cover' }];
        const map = await resolveWorkingDays({ employeeId: 1, tenantId: TENANT, from: SUNDAY, to: SUNDAY });
        expect(map.get(SUNDAY)).toMatchObject({ working: true, reason: 'ON_CALL' });
    });

    it('a call-in beats a ROTATION rest day too', async () => {
        schedules = [{
            schedule_pattern: {
                type: 'rotating',
                rotatingShifts: [{ from: '10:00', to: '22:00' }, { from: '22:00', to: '10:00' }],
                offDays: [],
                cycle: { days: 3, anchor: '2026-08-01', offIndex: 1 }, // 08-02 rests
            },
            effective_start_date: new Date('2020-01-01T00:00:00.000Z'),
            effective_end_date: null,
        }];
        const restDay = await resolveWorkingDays({ employeeId: 1, tenantId: TENANT, from: SUNDAY, to: SUNDAY });
        expect(restDay.get(SUNDAY)).toMatchObject({ working: false, reason: 'ROTATION_OFF' });

        callIns = [{ date: day(SUNDAY), reason: 'on-call cover' }];
        const called = await resolveWorkingDays({ employeeId: 1, tenantId: TENANT, from: SUNDAY, to: SUNDAY });
        expect(called.get(SUNDAY)).toMatchObject({ working: true, reason: 'ON_CALL' });
    });

    it('approved leave outranks a call-in', async () => {
        callIns = [{ date: day(SUNDAY), reason: 'weekend site cover' }];
        leaves = [{ start_date: day(SUNDAY), end_date: day(SUNDAY), type: 'ANNUAL' }];
        const map = await resolveWorkingDays({ employeeId: 1, tenantId: TENANT, from: SUNDAY, to: SUNDAY });
        expect(map.get(SUNDAY)).toMatchObject({ working: false, reason: 'APPROVED_LEAVE' });
    });
});

describe('HR-ATT-ONCALL-01 no-show -> ABSENT', () => {
    it('restates the stale WEEKLY_OFF row on a called-in day to ABSENT', async () => {
        callIns = [{ date: day(SUNDAY), reason: 'weekend site cover' }];
        attendanceRows = [{ id: 5, date: day(SUNDAY), status: 'WEEKLY_OFF', manually_corrected: false }];

        const s = await svc.markAbsences({ tenantId: TENANT, from: SUNDAY, to: SUNDAY, dryRun: false });

        expect(s.marked).toBe(1);
        expect(updated).toHaveLength(1);
        expect(updated[0].data).toMatchObject({
            status: 'ABSENT',
            day_credit: 0,
            requires_regularization: true,
        });
        expect(created).toHaveLength(0);
    });

    it('leaves an already-scored day alone (guard 3 stands)', async () => {
        callIns = [{ date: day(SUNDAY), reason: 'weekend site cover' }];
        attendanceRows = [{ id: 5, date: day(SUNDAY), status: 'PRESENT', manually_corrected: false }];

        const s = await svc.markAbsences({ tenantId: TENANT, from: SUNDAY, to: SUNDAY, dryRun: false });

        expect(s.alreadyPresent).toBe(1);
        expect(s.marked).toBe(0);
        expect(updated).toHaveLength(0);
    });

    it('without a call-in the Sunday is not worked and nothing is marked', async () => {
        attendanceRows = [{ id: 5, date: day(SUNDAY), status: 'WEEKLY_OFF', manually_corrected: false }];

        const s = await svc.markAbsences({ tenantId: TENANT, from: SUNDAY, to: SUNDAY, dryRun: false });

        expect(s.notWorking).toBe(1);
        expect(s.marked).toBe(0);
        expect(updated).toHaveLength(0);
    });
});

describe('HR-ATT-ROSTER-CORRECTION-01 stale rest day after the roster moves', () => {
    // A correction moves the rest day (Mon off -> Sun off). The row written for
    // the old rest day is stale: the resolver now calls that date working, so
    // absence marking must restate it to ABSENT, exactly as for a call-in.
    const MON = '2026-09-21'; // Monday
    const SUNDAY_20 = '2026-09-20'; // Sunday
    const twoSchedules = () => ([
        {
            schedule_pattern: { type: 'weekly', shift: { from: '10:00', to: '22:00' }, offDays: [1], shiftHours: 12 },
            effective_start_date: new Date('2020-01-01T00:00:00.000Z'),
            effective_end_date: new Date('2026-09-15T00:00:00.000Z'),
        },
        {
            schedule_pattern: { type: 'weekly', shift: { from: '10:00', to: '22:00' }, offDays: [7], shiftHours: 12 },
            effective_start_date: new Date('2026-09-16T00:00:00.000Z'),
            effective_end_date: null,
        },
    ]);

    it('restates a rest-day row the corrected roster now calls working', async () => {
        schedules = twoSchedules();
        attendanceRows = [{ id: 9, date: day(MON), status: 'WEEKLY_OFF', manually_corrected: false }];

        const s = await svc.markAbsences({ tenantId: TENANT, from: MON, to: MON, dryRun: false });

        expect(s.marked).toBe(1);
        expect(updated).toHaveLength(1);
        expect(updated[0].data).toMatchObject({
            status: 'ABSENT',
            day_credit: 0,
            requires_regularization: true,
            remarks: 'No attendance recorded on a scheduled working day',
        });
        expect(created).toHaveLength(0);
    });

    it('leaves the rest-day row alone while the roster still calls the day off', async () => {
        attendanceRows = [{ id: 9, date: day(SUNDAY_20), status: 'WEEKLY_OFF', manually_corrected: false }];

        const s = await svc.markAbsences({ tenantId: TENANT, from: SUNDAY_20, to: SUNDAY_20, dryRun: false });

        expect(s.notWorking).toBe(1);
        expect(s.marked).toBe(0);
        expect(updated).toHaveLength(0);
    });
});

// HR-ATT-OFFDAY-01 — a lone scan on a rostered off day is not a shift.
//
// The evaluator sessionises punches without asking whether the day was a
// working one, so a single scan on somebody's weekend opens a session, gets one
// punch, and lands as MISSING_CHECKOUT: a chargeable, payroll-blocking row on a
// day nobody was rostered.
//
// This was patched by hand eleven times and did not hold. Deleting the rows
// left the punches in place, so the next re-derivation rebuilt every one of
// them — Sameer and Usman's Thursdays, hamza's Saturdays, Hari Lal's Sunday,
// Azeem's Saturday, the four EMG rotation rest days. A rule the data can
// regenerate around is not a fix.
//
// Where these scans come from, per HR: people do not always leave on time, so a
// 05:06 punch is the tail of the previous evening's shift rather than the start
// of a new one; and people scan in out of habit on a day off ("muscle memory")
// without working.
//
// So: on a day the roster calls non-working, a session holding a SINGLE punch
// produces no attendance row. A complete pair is kept — somebody genuinely
// working their rest day is real and must still be paid and visible. The punch
// itself is never deleted: it stays in attendance_device_punches, so a
// mis-rostered day can be recovered by fixing the roster and re-deriving.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 'tenant-1';
const EMPLOYEE = 77;

let punches;
let workingDays;

const prismaMock = {
    attendanceDevicePunch: {
        findMany: jest.fn(async () => punches),
    },
    workSchedule: {
        findFirst: jest.fn(async () => ({
            schedule_pattern: {
                type: 'weekly',
                offDays: [6, 7],
                shift: { from: '09:00', to: '18:00' },
            },
        })),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/services/workingDay.service.js', () => ({
    resolveWorkingDays: jest.fn(async () => workingDays),
}));

const { replayTenant } = await import('../../src/lib/attendanceReplay.js');

const at = (iso, hhmm) => ({
    employeeId: EMPLOYEE,
    punchedAt: new Date(`${iso}T${hhmm}:00.000Z`),
    status: 0,
});

const workDay = (iso) => [iso, { date: new Date(`${iso}T00:00:00.000Z`), working: true, reason: null }];
const offDay = (iso, reason = 'OFF_DAY') =>
    [iso, { date: new Date(`${iso}T00:00:00.000Z`), working: false, reason }];

const run = () => replayTenant({
    tenantId: TENANT, from: '2026-08-03', to: '2026-08-09',
    policy: {}, now: new Date('2026-08-20T00:00:00.000Z'),
});

const days = (results) => results.map((r) => r.day.toISOString().slice(0, 10));

beforeEach(() => {
    jest.clearAllMocks();
    punches = [];
    workingDays = new Map();
});

describe('HR-ATT-OFFDAY-01 lone scan on a rest day', () => {
    it('produces no row for a single scan on a weekly off day', async () => {
        // hamza's 05:06 on a Saturday: the tail of Friday's shift, not a shift.
        punches = [at('2026-08-08', '05:06')];
        workingDays = new Map([offDay('2026-08-08')]);

        expect(days(await run())).not.toContain('2026-08-08');
    });

    it('produces no row for a single scan on a rotation rest day', async () => {
        punches = [at('2026-08-08', '10:30')];
        workingDays = new Map([offDay('2026-08-08', 'ROTATION_OFF')]);

        expect(await run()).toHaveLength(0);
    });

    it('KEEPS a complete pair on an off day — working a rest day is real', async () => {
        punches = [at('2026-08-08', '09:04'), at('2026-08-08', '18:12')];
        workingDays = new Map([offDay('2026-08-08')]);

        const results = await run();

        expect(days(results)).toContain('2026-08-08');
        expect(results[0].verdict.checkOut).toBeTruthy();
    });

    it('still produces a row for a single scan on a WORKING day', async () => {
        // The incomplete-shift path is untouched: a missing check-out on a day
        // somebody was rostered is a real thing for HR to regularise.
        punches = [at('2026-08-05', '09:02')];
        workingDays = new Map([workDay('2026-08-05')]);

        expect(days(await run())).toContain('2026-08-05');
    });

    it('does not suppress a day the resolver says nothing about', async () => {
        // Silence is not permission to drop attendance. An employee with no
        // roster keeps every day they scan on.
        punches = [at('2026-08-05', '09:02')];
        workingDays = new Map();

        expect(days(await run())).toContain('2026-08-05');
    });

    it('leaves the punches themselves alone', async () => {
        punches = [at('2026-08-08', '05:06')];
        workingDays = new Map([offDay('2026-08-08')]);

        await run();

        // Read-only: nothing in the replay path deletes or rewrites a punch, so
        // fixing a wrong roster and re-deriving brings the day back.
        expect(prismaMock.attendanceDevicePunch.findMany).toHaveBeenCalled();
        expect(prismaMock.attendanceDevicePunch.delete).toBeUndefined();
    });
});

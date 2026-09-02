// HR-ATT-ROLLUP-01 — the daily roll-up must follow the employee's real shift,
// not the calendar day and not a hardcoded 09:00.
//
// Two defects this pins down:
//  1. syncAttendanceFromPunches grouped by `dayKey(timestamp)`, so a night shift
//     (20:00 -> 05:00) became TWO rows, each with one punch and zero hours. 380
//     of 1628 August shifts crossed midnight, so ~23% of the month was wrong.
//  2. Lateness was judged against the `shiftStart` parameter, default "09:00".
//     A 22:00 night-shift worker checking in at 22:15 was stamped HALF_DAY.
//     Shift start now comes from work_schedules.schedule_pattern.
// Runs under TZ=UTC — pinned in tests/setup/tz.js, because ESM imports hoist
// above any assignment made here.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '8ff0533b-62f6-4be9-a78e-69adf49e00bc';
// 22:00 -> 08:00 night shift, i.e. the Homenet roster.
const NIGHT = { id: 501, employee_code: 'EMP501', employee_name: 'Night Worker', work_mode: 'On-site', tenant_id: TENANT, biometric_id: '1009' };
// 10:00 -> 18:00 day shift.
const MIDNIGHT = { id: 503, employee_code: 'EMP503', employee_name: 'Midnight Worker', work_mode: 'On-site', tenant_id: TENANT, biometric_id: '1016' };
const DAY = { id: 502, employee_code: 'EMP502', employee_name: 'Day Worker', work_mode: 'On-site', tenant_id: TENANT, biometric_id: '1010' };

const SCHEDULES = {
    501: { shift: { from: '22:00', to: '08:00' }, offDays: [6, 7], type: 'weekly' },
    502: { shift: { from: '10:00', to: '18:00' }, offDays: [6, 7], type: 'weekly' },
    // Midnight-start shift: EMP177 on the real roster. Its workers clock in
    // BEFORE midnight, i.e. early for a shift that starts at 00:00.
    503: { shift: { from: '00:00', to: '10:00' }, offDays: [6, 7], type: 'weekly' },
};

let attendance = [];
let nextId = 1;

const prismaMock = {
    employee: {
        findUnique: jest.fn(async ({ where }) => [NIGHT, DAY, MIDNIGHT].find((e) => e.id === where.id) ?? null),
        findFirst: jest.fn(async ({ where }) => {
            const codes = where.OR.flatMap((c) => [c.biometric_id, c.employee_code]).filter(Boolean);
            return [NIGHT, DAY, MIDNIGHT].find(
                (e) => codes.includes(e.biometric_id) || codes.includes(e.employee_code),
            ) ?? null;
        }),
    },
    // Per-day work-mode override lookup (HR-ATT-POLICY-01). No override here, so
    // the day falls back to the employee's default.
    shiftAssignment: { findFirst: jest.fn(async () => null) },
    workSchedule: {
        findFirst: jest.fn(async ({ where }) =>
            SCHEDULES[where.employeeId]
                ? { schedule_pattern: SCHEDULES[where.employeeId] }
                : null,
        ),
    },
    attendance: {
        findFirst: jest.fn(async ({ where, orderBy }) => {
            let rows = attendance.filter((r) => r.employeeId === where.employeeId);
            if (where.check_in) {
                rows = rows.filter(
                    (r) => r.check_in && r.check_in >= where.check_in.gte && r.check_in <= where.check_in.lte,
                );
            }
            if (where.date) {
                rows = rows.filter((r) => r.date >= where.date.gte && r.date <= where.date.lte);
            }
            if (orderBy?.check_in === 'desc') rows.sort((a, b) => b.check_in - a.check_in);
            else rows.sort((a, b) => b.id - a.id);
            return rows[0] ?? null;
        }),
        create: jest.fn(async ({ data }) => {
            const row = { id: nextId++, ...data };
            attendance.push(row);
            return row;
        }),
        update: jest.fn(async ({ where, data }) => {
            const row = attendance.find((r) => r.id === where.id);
            Object.assign(row, data);
            return row;
        }),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { syncAttendanceFromPunches } = await import('../../src/services/attendance.device.service.js');

const punch = (bio, iso, type) => ({ deviceUserId: bio, timestamp: iso, type });

beforeEach(() => {
    attendance = [];
    nextId = 1;
    jest.clearAllMocks();
});

// Local helper: this suite otherwise builds dates inline.
const dayAt = (iso) => { const x = new Date(iso); x.setHours(0, 0, 0, 0); return x; };

describe('HR-ATT-CORRECTION-01 manual corrections survive a device sync', () => {
    it('does NOT overwrite a day HR corrected by hand', async () => {
        // The whole point of the correction feature. If the sync rewrites the
        // day, HR fixes it, the next push undoes it, and nobody notices until
        // payroll is wrong.
        attendance.push({
            id: 99, employeeId: 501, date: dayAt('2026-08-14'),
            check_in: new Date('2026-08-14T22:00:00Z'), check_out: new Date('2026-08-15T08:00:00Z'),
            total_hours: 10, status: 'PRESENT', manually_corrected: true,
        });

        const res = await syncAttendanceFromPunches({
            punches: [punch('1009', '2026-08-14T23:30:00', '0')],
        });

        expect(res.skipped).toBe(1);
        expect(res.details[0].action).toBe('skipped_manually_corrected');
        // Untouched: same times, same hours.
        expect(attendance[0].check_in.toISOString()).toBe('2026-08-14T22:00:00.000Z');
        expect(attendance[0].total_hours).toBe(10);
    });

    it('still updates an ordinary day', async () => {
        attendance.push({
            id: 98, employeeId: 501, date: dayAt('2026-08-14'),
            check_in: new Date('2026-08-14T22:00:00Z'), check_out: null,
            total_hours: null, status: 'PRESENT', manually_corrected: false,
        });

        const res = await syncAttendanceFromPunches({
            punches: [punch('1009', '2026-08-15T08:00:00', '1')],
        });

        expect(res.skipped).toBe(0);
        expect(res.updated).toBe(1);
    });
});

describe('HR-ATT-ROLLUP-01 shift-aware daily roll-up', () => {
    it('keeps a midnight-crossing night shift as ONE row on the start date', async () => {
        await syncAttendanceFromPunches({
            punches: [
                punch('1009', '2026-08-14T22:04:00', '0'),
                punch('1009', '2026-08-15T05:53:00', '1'),
            ],
        });

        expect(attendance).toHaveLength(1);
        const [row] = attendance;
        expect(row.date.getDate()).toBe(14);              // attributed to the 14th
        expect(row.check_out.getDate()).toBe(15);         // even though it ends on the 15th
        expect(row.total_hours).toBeCloseTo(7.82, 1);
    });

    it('separates two shifts more than the session gap apart', async () => {
        await syncAttendanceFromPunches({
            punches: [
                punch('1010', '2026-08-14T10:02:00', '0'),
                punch('1010', '2026-08-14T18:10:00', '1'),
                punch('1010', '2026-08-15T10:05:00', '0'),
                punch('1010', '2026-08-15T18:01:00', '1'),
            ],
        });

        expect(attendance).toHaveLength(2);
        expect(attendance.map((r) => r.date.getDate()).sort()).toEqual([14, 15]);
    });

    it('continues an already-open night shift when the OUT punch arrives alone', async () => {
        // The device pushes live, so the 05:xx check-out lands in its own batch.
        await syncAttendanceFromPunches({ punches: [punch('1009', '2026-08-14T22:04:00', '0')] });
        expect(attendance).toHaveLength(1);

        await syncAttendanceFromPunches({ punches: [punch('1009', '2026-08-15T05:53:00', '1')] });

        expect(attendance).toHaveLength(1);               // updated, not a new day
        expect(attendance[0].date.getDate()).toBe(14);
        expect(attendance[0].total_hours).toBeCloseTo(7.82, 1);
    });

    it('judges lateness against the employee roster shift, not 09:00', async () => {
        await syncAttendanceFromPunches({
            punches: [punch('1009', '2026-08-14T22:15:00', '0')],
        });

        // 22:15 against a 22:00 shift is 15 min late -> LATE, not HALF_DAY.
        // Against the old hardcoded 09:00 this was HALF_DAY.
        expect(attendance[0].status).toBe('LATE');
        expect(prismaMock.workSchedule.findFirst).toHaveBeenCalled();
    });

    it('treats an after-midnight arrival on a night shift as late, not early', async () => {
        await syncAttendanceFromPunches({
            punches: [punch('1009', '2026-08-15T00:30:00', '0')],
        });

        // 00:30 is 2.5h into a 22:00 shift. Comparing raw minutes-of-day made it
        // look 21.5h EARLY and scored PRESENT.
        expect(attendance[0].status).toBe('HALF_DAY');
    });

    it('treats a pre-midnight arrival for a 00:00 shift as early, not a day late', async () => {
        await syncAttendanceFromPunches({
            punches: [punch('1016', '2026-08-11T23:05:15', '0')],
        });

        // 23:05 is 55 min BEFORE a 00:00 shift. Wrapping only one way scored it
        // 23h late -> HALF_DAY; caught by replaying EMP177 against live prod.
        expect(attendance[0].status).toBe('PRESENT');
    });

    it('marks an on-time day-shift arrival PRESENT', async () => {
        await syncAttendanceFromPunches({
            punches: [punch('1010', '2026-08-14T09:58:00', '0')],
        });

        expect(attendance[0].status).toBe('PRESENT');
    });
});

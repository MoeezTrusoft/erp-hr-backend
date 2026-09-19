// HR-ATT-CORRECTION-01 — HR/admin manual attendance correction.
//
// The device cannot be the only authority: it was out of service on some days,
// people press the wrong key, and HR holds a reconciled record the machine never
// saw. August produced 527 employee-days needing human review.
//
// The property that matters most is that a correction SURVIVES the next device
// sync. If the roll-up overwrites it, HR fixes a day, the next push undoes it,
// and nobody notices until payroll is wrong.
//
// HR-ATT-CORRECTION-POLICY-01 (operator items 7+8, 2026-09-15) narrows the
// surface:
//   #7 — a manual correction may ONLY fix a MISSING_CHECKIN / MISSING_CHECKOUT
//        day. Device-scored days are out of scope (anomaly/leave workflow).
//   #8 — a day with NO device row is a manual ENTRY: WFH (Remote/Hybrid) only,
//        landing PENDING management approval (requires_regularization stays
//        true, day_credit stays null until approved).
// Status is always DERIVED from the supplied times, never asserted by the
// caller — a correction supplies the missing punch, it does not re-grade.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const EMP = 100;
const HR_ACTOR = 900;

let attendanceRows;
let logs;
let employeeWorkMode;
let employeeTenant;

const prismaMock = {
    employee: { findUnique: jest.fn(async () => ({ id: EMP, tenant_id: employeeTenant, work_mode: employeeWorkMode })) },
    attendance: {
        findFirst: jest.fn(async ({ where }) =>
            attendanceRows.find((r) => r.employeeId === where.employeeId
                && (!where.date?.getTime || r.date.getTime() === where.date.getTime())) ?? null),
        findMany: jest.fn(async () => attendanceRows.filter((r) => r.manually_corrected)),
        create: jest.fn(async ({ data }) => { const r = { id: attendanceRows.length + 1, ...data }; attendanceRows.push(r); return r; }),
        update: jest.fn(async ({ where, data }) => {
            const r = attendanceRows.find((x) => x.id === where.id);
            Object.assign(r, data);
            return r;
        }),
    },
    log: { create: jest.fn(async ({ data }) => { logs.push(data); return { id: logs.length, ...data }; }) },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_c, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const svc = await import('../../src/services/attendanceCorrection.service.js');

const base = { tenantId: TENANT, employeeId: EMP, actorEmployeeId: HR_ACTOR, reason: 'machine was down' };

beforeEach(() => {
    jest.clearAllMocks();
    attendanceRows = [];
    logs = [];
    employeeWorkMode = 'Remote'; // WFH by default: manual entries are the allowed path
    employeeTenant = TENANT;
});

describe('HR-ATT-CORRECTION-01 tenant boundary', () => {
    it('rejects an employee id owned by another tenant', async () => {
        employeeTenant = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';
        await expect(
            svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00' }),
        ).rejects.toThrow('not found in this tenant');
        expect(prismaMock.attendance.create).not.toHaveBeenCalled();
    });
});

describe('HR-ATT-CORRECTION-01 correcting a MISSING_* day (#7)', () => {
    it('completes a day the device left half-recorded', async () => {
        attendanceRows.push({ id: 1, employeeId: EMP, date: new Date('2026-08-14T00:00:00'),
            status: 'MISSING_CHECKOUT', requires_regularization: true, day_credit: null });

        const r = await svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00' });

        expect(r.created).toBe(false);
        expect(r.total_hours).toBe(8);
        expect(r.status).toBe('PRESENT');
        expect(r.day_credit).toBe(1.0);
        expect(r.manually_corrected).toBe(true);
    });

    it('clears the regularization hold, because HR has ruled on the day', async () => {
        attendanceRows.push({ id: 1, employeeId: EMP, date: new Date('2026-08-14T00:00:00'),
            status: 'MISSING_CHECKOUT', requires_regularization: true, day_credit: null });

        await svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00' });

        expect(attendanceRows[0].requires_regularization).toBe(false);
        expect(attendanceRows[0].day_credit).toBe(1.0);
    });

    it('rolls a night-shift check-out into the next day automatically', async () => {
        // 22:00 -> 08:00. Without the roll this reads as an 08:00 finish that
        // precedes the start, and HR would have to enter dates by hand.
        attendanceRows.push({ id: 1, employeeId: EMP, date: new Date('2026-08-14T00:00:00'),
            status: 'MISSING_CHECKIN', requires_regularization: true, day_credit: null });

        const r = await svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '22:00', checkOut: '08:00' });

        expect(r.check_out.getDate()).toBe(15);
        expect(r.total_hours).toBe(10);
    });

    it('derives status from the times and IGNORES a caller-supplied status', async () => {
        attendanceRows.push({ id: 1, employeeId: EMP, date: new Date('2026-08-14T00:00:00'),
            status: 'MISSING_CHECKOUT', requires_regularization: true, day_credit: null });

        // The caller tries to declare HALF_DAY; the service derives PRESENT
        // from a full 10:00-18:00 span instead.
        const r = await svc.correctAttendanceDay({
            ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00', status: 'HALF_DAY',
        });

        expect(r.status).toBe('PRESENT');
        expect(r.day_credit).toBe(1.0);
    });

    it('records who changed it, when and why', async () => {
        attendanceRows.push({ id: 1, employeeId: EMP, date: new Date('2026-08-14T00:00:00'),
            status: 'MISSING_CHECKOUT', requires_regularization: true, day_credit: null });

        await svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00' });

        expect(attendanceRows[0].corrected_by_id).toBe(HR_ACTOR);
        expect(attendanceRows[0].correction_reason).toBe('machine was down');
        expect(attendanceRows[0].corrected_at).toBeInstanceOf(Date);

        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({ actionById: HR_ACTOR, module: 'attendance' });
        expect(logs[0].notes).toContain('machine was down');
    });

    it('refuses to re-grade a day the device already scored (#7)', async () => {
        attendanceRows.push({ id: 1, employeeId: EMP, date: new Date('2026-08-14T00:00:00'),
            status: 'PRESENT', requires_regularization: false, day_credit: 1.0 });

        await expect(
            svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '09:00', checkOut: '17:00' }),
        ).rejects.toThrow('Only days with a missing check-in or check-out');
    });
});

describe('HR-ATT-CORRECTION-01 manual entry from nothing (#8)', () => {
    it('creates a WFH day PENDING management approval', async () => {
        const r = await svc.correctAttendanceDay({
            ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00', workMode: 'Remote',
        });

        expect(r.created).toBe(true);
        expect(r.manually_corrected).toBe(true);
        // Held: payroll must not pay an unapproved entry.
        expect(r.day_credit).toBeNull();
        expect(attendanceRows[0].requires_regularization).toBe(true);
        expect(attendanceRows[0].correction_reason).toContain('pending management approval');
    });

    it('accepts a Hybrid day as WFH', async () => {
        const r = await svc.correctAttendanceDay({
            ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00', workMode: 'Hybrid',
        });
        expect(r.created).toBe(true);
        expect(r.day_credit).toBeNull();
    });

    it('refuses a manual entry for an on-site employee (#8)', async () => {
        employeeWorkMode = 'On-site';

        await expect(
            svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00' }),
        ).rejects.toThrow('WFH (Remote/Hybrid)');
    });

    it('refuses an explicit Onsite work mode even for a remote employee', async () => {
        await expect(
            svc.correctAttendanceDay({
                ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00', workMode: 'Onsite',
            }),
        ).rejects.toThrow('WFH (Remote/Hybrid)');
    });
});

describe('HR-ATT-CORRECTION-01 refusals', () => {
    it('requires a reason', async () => {
        await expect(
            svc.correctAttendanceDay({ ...base, reason: '   ', date: '2026-08-14', checkIn: '10:00' }),
        ).rejects.toThrow('reason is required');
    });

    it('requires an identified actor', async () => {
        await expect(
            svc.correctAttendanceDay({ ...base, actorEmployeeId: null, date: '2026-08-14', checkIn: '10:00' }),
        ).rejects.toThrow('actorEmployeeId is required');
    });

    it('rejects a malformed time rather than guessing', async () => {
        await expect(
            svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10am' }),
        ).rejects.toThrow('HH:MM');
    });
});

describe('HR-ATT-CORRECTION-01 audit listing', () => {
    it('returns only corrected days', async () => {
        attendanceRows.push(
            { id: 1, employeeId: EMP, date: new Date('2026-08-01'), manually_corrected: true },
            { id: 2, employeeId: EMP, date: new Date('2026-08-02'), manually_corrected: false },
        );

        const rows = await svc.listCorrections({ tenantId: TENANT });

        expect(rows.map((r) => r.id)).toEqual([1]);
    });
});

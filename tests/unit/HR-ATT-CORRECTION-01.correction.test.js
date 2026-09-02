// HR-ATT-CORRECTION-01 — HR/admin manual attendance correction.
//
// The device cannot be the only authority: it was out of service on some days,
// people press the wrong key, and HR holds a reconciled record the machine never
// saw. August produced 527 employee-days needing human review.
//
// The property that matters most is that a correction SURVIVES the next device
// sync. If the roll-up overwrites it, HR fixes a day, the next push undoes it,
// and nobody notices until payroll is wrong.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const EMP = 100;
const HR_ACTOR = 900;

let attendanceRows;
let logs;

const prismaMock = {
    employee: { findUnique: jest.fn(async () => ({ id: EMP, tenant_id: TENANT, work_mode: 'On-site' })) },
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
});

describe('HR-ATT-CORRECTION-01 correcting a day', () => {
    it('creates a day the device never recorded', async () => {
        const r = await svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00' });

        expect(r.created).toBe(true);
        expect(r.total_hours).toBe(8);
        expect(r.status).toBe('PRESENT');
        expect(r.day_credit).toBe(1.0);
        expect(r.manually_corrected).toBe(true);
    });

    it('rolls a night-shift check-out into the next day automatically', async () => {
        // 22:00 -> 08:00. Without the roll this reads as an 08:00 finish that
        // precedes the start, and HR would have to enter dates by hand.
        const r = await svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '22:00', checkOut: '08:00' });

        expect(r.check_out.getDate()).toBe(15);
        expect(r.total_hours).toBe(10);
    });

    it('clears the regularization hold, because HR has ruled on the day', async () => {
        attendanceRows.push({ id: 1, employeeId: EMP, date: new Date('2026-08-14T00:00:00'),
            status: 'MISSING_CHECKOUT', requires_regularization: true, day_credit: null });

        await svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00' });

        expect(attendanceRows[0].requires_regularization).toBe(false);
        expect(attendanceRows[0].day_credit).toBe(1.0);
    });

    it('lets HR state the status explicitly', async () => {
        const r = await svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '14:00', status: 'HALF_DAY' });

        expect(r.status).toBe('HALF_DAY');
        expect(r.day_credit).toBe(0.5);
    });

    it('records who changed it, when and why', async () => {
        await svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10:00', checkOut: '18:00' });

        expect(attendanceRows[0].corrected_by_id).toBe(HR_ACTOR);
        expect(attendanceRows[0].correction_reason).toBe('machine was down');
        expect(attendanceRows[0].corrected_at).toBeInstanceOf(Date);

        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({ actionById: HR_ACTOR, module: 'attendance' });
        expect(logs[0].notes).toContain('machine was down');
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

    it('rejects an unknown status', async () => {
        await expect(
            svc.correctAttendanceDay({ ...base, date: '2026-08-14', checkIn: '10:00', status: 'ON_LEAVE' }),
        ).rejects.toThrow('status must be one of');
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

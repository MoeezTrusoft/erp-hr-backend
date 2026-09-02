// HR-ATT-ABSENCE-01 — marking a no-show as absent.
//
// This creates UNPAID days, so the guards matter more than the happy path:
// 8 of 75 employees have no device enrolment and would otherwise be marked
// absent every single day, and a day HR corrected by hand must never be
// overwritten by a batch job.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const ENROLLED = { id: 1, employee_code: 'EMP001', biometric_id: '3001' };

let employees, unenrolledCount, attendanceRows, workingMap, created;

const prismaMock = {
    employee: {
        findMany: jest.fn(async () => employees),
        count: jest.fn(async () => unenrolledCount),
    },
    attendance: {
        findMany: jest.fn(async () => attendanceRows),
        create: jest.fn(async ({ data }) => { created.push(data); return { id: created.length, ...data }; }),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_c, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/services/workingDay.service.js', () => ({
    resolveWorkingDays: jest.fn(async () => workingMap),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const svc = await import('../../src/services/absenceMarking.service.js');
const day = (s) => { const d = new Date(s); d.setHours(0, 0, 0, 0); return d; };
const working = (...days) => new Map(days.map((k) => [k, { working: true }]));

beforeEach(() => {
    jest.clearAllMocks();
    employees = [ENROLLED];
    unenrolledCount = 8;
    attendanceRows = [];
    created = [];
    workingMap = working('2026-08-10', '2026-08-11');
});

describe('HR-ATT-ABSENCE-01 guards', () => {
    it('only considers employees enrolled on the device', async () => {
        const s = await svc.markAbsences({ tenantId: TENANT, from: '2026-08-10', to: '2026-08-11' });

        // 8 people have no biometric_id and generate no punches whatever they
        // do — marking them absent daily would dock them for not being enrolled.
        expect(prismaMock.employee.findMany.mock.calls[0][0].where.biometric_id).toEqual({ not: null });
        expect(s.skippedNotEnrolled).toBe(8);
    });

    it('skips days the employee was not scheduled to work', async () => {
        workingMap = new Map([
            ['2026-08-10', { working: false, reason: 'OFF_DAY' }],
            ['2026-08-11', { working: false, reason: 'HOLIDAY' }],
        ]);

        const s = await svc.markAbsences({ tenantId: TENANT, from: '2026-08-10', to: '2026-08-11' });

        expect(s.marked).toBe(0);
        expect(s.notWorking).toBe(2);
    });

    it('never overwrites a day that already has attendance', async () => {
        attendanceRows = [{ id: 5, date: day('2026-08-10'), manually_corrected: false }];

        const s = await svc.markAbsences({ tenantId: TENANT, from: '2026-08-10', to: '2026-08-11' });

        expect(s.alreadyPresent).toBe(1);
        expect(s.marked).toBe(1);      // only the 11th
    });

    it('never overwrites a day HR corrected by hand', async () => {
        attendanceRows = [{ id: 5, date: day('2026-08-10'), manually_corrected: true }];

        const s = await svc.markAbsences({ tenantId: TENANT, from: '2026-08-10', to: '2026-08-11' });

        expect(s.manuallyCorrected).toBe(1);
    });
});

describe('HR-ATT-ABSENCE-01 writing', () => {
    it('defaults to a DRY RUN and writes nothing', async () => {
        const s = await svc.markAbsences({ tenantId: TENANT, from: '2026-08-10', to: '2026-08-11' });

        expect(s.dryRun).toBe(true);
        expect(s.marked).toBe(2);
        expect(created).toHaveLength(0);   // reported, not written
    });

    it('writes absences as regularizable, not final', async () => {
        await svc.markAbsences({ tenantId: TENANT, from: '2026-08-10', to: '2026-08-10', dryRun: false });

        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({
            status: 'ABSENT', day_credit: 0, requires_regularization: true,
        });
    });

    it('rejects a reversed range', async () => {
        await expect(
            svc.markAbsences({ tenantId: TENANT, from: '2026-08-11', to: '2026-08-10' }),
        ).rejects.toThrow('before');
    });
});

// HR-ATT-STATUS-01 — a day off is stated, not left blank.
//
// StatusAttendance had no way to say "not working". An off day was represented
// by the ABSENCE of an attendance row, which is indistinguishable from a day
// whose data never arrived. Nobody — HR, payroll, or an auditor — can tell the
// difference by looking.
//
// It also forced every cleanup to be a DELETE. HR-ATT-RETRACT-01 removes rows
// the roster no longer supports, and eleven off-day rows were deleted by hand
// before that; each deletion left exactly the same blank that means "unknown".
//
// So a non-working day inside an evaluated window is now WRITTEN:
//   OFF_DAY / ROTATION_OFF -> WEEKLY_OFF
//   HOLIDAY                -> HOLIDAY
//   APPROVED_LEAVE         -> ON_LEAVE
// with day_credit 0 and requires_regularization false. None of the three is in
// attendanceDeduction's STATUS_TO_RULE allow-list, so none of them can be
// charged; day_credit has no payroll consumer at all today. The rows are a
// statement of fact, not a price.
//
// Retraction restates rather than deletes: a row the roster no longer supports
// becomes the off-day it actually was.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 'tenant-1';
const EMPLOYEE = 90;

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const key = (d) => new Date(d).toISOString().slice(0, 10);

let shifts, storedRows, workingByDay, written, deleted;

const prismaMock = {
    attendance: {
        findFirst: jest.fn(async ({ where }) =>
            storedRows.find((r) => r.employeeId === where.employeeId
                && key(r.date) === key(where.date)) ?? null),
        findMany: jest.fn(async () => storedRows),
        update: jest.fn(async ({ where, data }) => { written.push({ id: where.id, ...data }); return {}; }),
        create: jest.fn(async ({ data }) => { written.push(data); return {}; }),
        createMany: jest.fn(async ({ data }) => { written.push(...data); return { count: data.length }; }),
        updateMany: jest.fn(async ({ where, data }) => {
            for (const id of where.id?.in ?? []) written.push({ id, ...data });
            return { count: (where.id?.in ?? []).length };
        }),
        delete: jest.fn(async ({ where }) => { deleted.push(where.id); return {}; }),
        deleteMany: jest.fn(async ({ where }) => {
            deleted.push(...(where.id?.in ?? [])); return { count: 0 };
        }),
    },
    shiftAssignment: { findFirst: jest.fn(async () => null) },
    employee: {
        findUnique: jest.fn(async () => ({ work_mode: null, tenant_id: TENANT })),
        findMany: jest.fn(async () => [{ id: EMPLOYEE }]),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_c, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/attendanceReplay.js', () => ({
    replayTenant: jest.fn(async () => shifts),
    dayKey: (d) => key(d),
}));
jest.unstable_mockModule('../../src/services/workingDay.service.js', () => ({
    resolveWorkingDays: jest.fn(async () => workingByDay),
}));
jest.unstable_mockModule('../../src/services/attendancePolicyConfig.service.js', () => ({
    getAttendancePolicy: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { applyEvaluatedShifts } = await import('../../src/services/attendanceWriter.service.js');

const off = (iso, reason = 'OFF_DAY') =>
    [iso, { date: day(iso), working: false, reason, detail: null }];
const work = (iso) => [iso, { date: day(iso), working: true, reason: null }];

beforeEach(() => {
    jest.clearAllMocks();
    written = []; deleted = []; shifts = []; storedRows = [];
    workingByDay = new Map();
});

const run = (opts = {}) => applyEvaluatedShifts({
    tenantId: TENANT, from: '2026-08-01', to: '2026-08-03', dryRun: false, ...opts,
});

const statusesWritten = () => written.map((w) => w.status);

describe('HR-ATT-STATUS-01 non-working days are written', () => {
    it('states a weekly off day instead of leaving a blank', async () => {
        workingByDay = new Map([off('2026-08-01'), work('2026-08-02'), work('2026-08-03')]);

        await run();

        expect(statusesWritten()).toContain('WEEKLY_OFF');
    });

    it('states a rotation rest day as an off day too', async () => {
        workingByDay = new Map([off('2026-08-01', 'ROTATION_OFF')]);

        await run();

        expect(statusesWritten()).toContain('WEEKLY_OFF');
    });

    it('states a holiday as a holiday', async () => {
        workingByDay = new Map([off('2026-08-01', 'HOLIDAY')]);

        await run();

        expect(statusesWritten()).toContain('HOLIDAY');
    });

    it('states approved leave as leave', async () => {
        workingByDay = new Map([off('2026-08-01', 'APPROVED_LEAVE')]);

        await run();

        expect(statusesWritten()).toContain('ON_LEAVE');
    });

    it('writes them unchargeable — zero credit, nothing to regularise', async () => {
        workingByDay = new Map([off('2026-08-01')]);

        await run();

        const row = written.find((w) => w.status === 'WEEKLY_OFF');
        expect(row.day_credit).toBe(0);
        expect(row.requires_regularization).toBe(false);
    });

    it('RESTATES a stale row rather than deleting it', async () => {
        // The retraction used to DELETE, leaving the same blank that means
        // "unknown". The row becomes the off day it actually was.
        storedRows = [{
            id: 7, employeeId: EMPLOYEE, date: day('2026-08-01'),
            status: 'ABSENT', manually_corrected: false,
        }];
        workingByDay = new Map([off('2026-08-01')]);

        await run();

        expect(deleted).toEqual([]);
        expect(written.find((w) => w.id === 7)?.status).toBe('WEEKLY_OFF');
    });

    it('never overwrites a day HR corrected by hand', async () => {
        storedRows = [{
            id: 8, employeeId: EMPLOYEE, date: day('2026-08-01'),
            status: 'PRESENT', manually_corrected: true,
        }];
        workingByDay = new Map([off('2026-08-01')]);

        await run();

        expect(written.find((w) => w.id === 8)).toBeUndefined();
        expect(deleted).toEqual([]);
    });

    it('leaves a worked rest day alone — the shift wins', async () => {
        shifts = [{
            employeeId: EMPLOYEE, day: day('2026-08-01'), corrections: [],
            verdict: {
                status: 'PRESENT', dayCredit: 1, checkIn: null, checkOut: null,
                workedMinutes: 480, requiresRegularization: false,
            },
        }];
        workingByDay = new Map([off('2026-08-01')]);

        await run();

        expect(statusesWritten()).not.toContain('WEEKLY_OFF');
    });

    it('bulk-writes without a query per row inside the transaction', async () => {
        // The first version issued one create AND one employee lookup per row,
        // all inside a single interactive transaction. A month is ~300 off-days
        // per tenant, so it blew the 5s budget at 5006ms and Postgres rolled
        // the whole pass back — nothing was written and the run exited 1.
        const days = [];
        for (let d = 1; d <= 31; d += 1) {
            days.push(off(`2026-08-${String(d).padStart(2, '0')}`));
        }
        workingByDay = new Map(days);

        await applyEvaluatedShifts({
            tenantId: TENANT, from: '2026-08-01', to: '2026-08-31', dryRun: false,
        });

        expect(written).toHaveLength(31);
        expect(prismaMock.attendance.create).not.toHaveBeenCalled();
        expect(prismaMock.attendance.createMany).toHaveBeenCalled();
        // Employee tenants are resolved in ONE query, before the write.
        expect(prismaMock.employee.findUnique).not.toHaveBeenCalled();
    });

    it('writes nothing under dryRun', async () => {
        workingByDay = new Map([off('2026-08-01')]);

        const res = await run({ dryRun: true });

        expect(written).toEqual([]);
        expect(res.nonWorking).toBe(1);
    });
});

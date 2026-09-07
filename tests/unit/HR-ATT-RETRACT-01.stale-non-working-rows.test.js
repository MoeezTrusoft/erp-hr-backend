// HR-ATT-RETRACT-01 — correcting a roster must retract the rows it invalidates.
//
// applyEvaluatedShifts only ever adds or updates. A day that produces no shift
// produces no write, so a stored row on that day survives whatever happens to
// the roster underneath it.
//
// That is fine while rosters are static and wrong the moment one is corrected.
// The EMG rotation is the worked example: the six rotators had ABSENT and
// MISSING_CHECKOUT rows manufactured on days the roster did not yet know were
// rest days. Writing the rotation phase stopped NEW ones appearing, and a
// re-evaluation reported "unchanged" for every one of the 31 already there —
// because a rest day yields no shift, so the writer never looked at them.
//
// Each of those rows is chargeable against somebody's pay. A stale ABSENT is an
// unpaid day for work that was never missed.
//
// So the writer reconciles rather than accumulates: a stored row in the window
// that the evaluator did not produce, on a day the roster now calls non-working,
// is retracted. The three guards that keep this safe:
//   * only days with NO evaluated shift — a day with punches is never touched
//     here, it goes down the normal update path;
//   * only days resolveWorkingDays calls non-working — a real absence on a real
//     working day stays exactly where it is;
//   * never a row HR corrected by hand (HR-ATT-CORRECTION-01).
//
// Punches are not deleted. They still belong to the shift that owns them and
// are re-read from attendance_device_punches on the next evaluation.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73'; // EMG
const ROTATOR = 165; // Khurram

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const key = (d) => new Date(d).toISOString().slice(0, 10);

let shifts, storedRows, workingByDay, deleted, updated;

const prismaMock = {
    attendance: {
        findFirst: jest.fn(async ({ where }) =>
            storedRows.find(
                (r) => r.employeeId === where.employeeId && key(r.date) === key(where.date),
            ) ?? null,
        ),
        findMany: jest.fn(async () => storedRows),
        update: jest.fn(async ({ where, data }) => { updated.push({ id: where.id, ...data }); return {}; }),
        create: jest.fn(async () => ({})),
        createMany: jest.fn(async ({ data }) => ({ count: data.length })),
        updateMany: jest.fn(async ({ where, data }) => {
            for (const id of where.id?.in ?? []) updated.push({ id, ...data });
            return { count: (where.id?.in ?? []).length };
        }),
        delete: jest.fn(async ({ where }) => { deleted.push(where.id); return {}; }),
        deleteMany: jest.fn(async ({ where }) => {
            const ids = where.id?.in ?? [];
            deleted.push(...ids);
            return { count: ids.length };
        }),
    },
    shiftAssignment: { findFirst: jest.fn(async () => null) },
    employee: {
        findUnique: jest.fn(async () => ({ work_mode: null, tenant_id: TENANT })),
        // HR-ATT-STATUS-01 asks for the tracked roster so it can state the
        // non-working days that have no row at all.
        findMany: jest.fn(async () => [{ id: ROTATOR }]),
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

const restDay = (iso) => [iso, { date: day(iso), working: false, reason: 'ROTATION_OFF' }];
const workDay = (iso) => [iso, { date: day(iso), working: true, reason: null }];

beforeEach(() => {
    jest.clearAllMocks();
    deleted = [];
    updated = [];
    shifts = [];
    storedRows = [];
    workingByDay = new Map();
});

const run = (opts = {}) =>
    applyEvaluatedShifts({ tenantId: TENANT, from: '2026-08-01', to: '2026-08-05', dryRun: false, ...opts });

describe('HR-ATT-RETRACT-01 stale rows on days that stopped being working days', () => {
    it('retracts an ABSENT sitting on a rotation rest day', async () => {
        storedRows = [{ id: 11, employeeId: ROTATOR, date: day('2026-08-04'), status: 'ABSENT', manually_corrected: false }];
        workingByDay = new Map([workDay('2026-08-01'), restDay('2026-08-04')]);

        const res = await run();

        // HR-ATT-STATUS-01: the row is RESTATED as the off day it was, not
        // deleted — a blank is indistinguishable from data that never arrived.
        expect(deleted).toEqual([]);
        expect(updated.find((u) => u.id === 11)?.status).toBe('WEEKLY_OFF');
        expect(res.retracted).toBe(1);
    });

    it('retracts a MISSING_CHECKOUT on a rest day too', async () => {
        // The other half of the artifact: the previous night's closing scan,
        // pulled onto the following morning, leaving in=11:27 out=null.
        storedRows = [{ id: 12, employeeId: ROTATOR, date: day('2026-08-04'), status: 'MISSING_CHECKOUT', manually_corrected: false }];
        workingByDay = new Map([restDay('2026-08-04')]);

        await run();

        expect(updated.find((u) => u.id === 12)?.status).toBe('WEEKLY_OFF');
    });

    it('leaves a real ABSENT on a real working day alone', async () => {
        storedRows = [{ id: 13, employeeId: ROTATOR, date: day('2026-08-03'), status: 'ABSENT', manually_corrected: false }];
        workingByDay = new Map([workDay('2026-08-03')]);

        const res = await run();

        expect(updated.find((u) => u.id === 13)).toBeUndefined();
        expect(res.retracted).toBe(0);
    });

    it('never retracts a row HR corrected by hand', async () => {
        storedRows = [{ id: 14, employeeId: ROTATOR, date: day('2026-08-04'), status: 'ABSENT', manually_corrected: true }];
        workingByDay = new Map([restDay('2026-08-04')]);

        const res = await run();

        expect(updated.find((u) => u.id === 14)).toBeUndefined();
        expect(res.skippedManuallyCorrected).toBeGreaterThanOrEqual(1);
    });

    it('does not retract a day the evaluator produced a shift for', async () => {
        // Punches exist, so the day is the normal update path's business even
        // if the roster calls it non-working — somebody worked a rest day.
        shifts = [{
            employeeId: ROTATOR, day: day('2026-08-04'), corrections: [],
            verdict: { status: 'PRESENT', dayCredit: 1, checkIn: null, checkOut: null, workedMinutes: 600, requiresRegularization: false },
        }];
        storedRows = [{ id: 15, employeeId: ROTATOR, date: day('2026-08-04'), status: 'ABSENT', manually_corrected: false }];
        workingByDay = new Map([restDay('2026-08-04')]);

        const res = await run();

        // It IS written — by the normal shift path, to what the punches say.
        // What must not happen is it being restated as an off day.
        expect(updated.find((u) => u.id === 15)?.status).toBe('PRESENT');
        expect(res.retracted).toBe(0);
    });

    it('reports but does not write under dryRun', async () => {
        storedRows = [{ id: 16, employeeId: ROTATOR, date: day('2026-08-04'), status: 'ABSENT', manually_corrected: false }];
        workingByDay = new Map([restDay('2026-08-04')]);

        const res = await run({ dryRun: true });

        expect(updated).toEqual([]);
        expect(res.retracted).toBe(1);
    });
});

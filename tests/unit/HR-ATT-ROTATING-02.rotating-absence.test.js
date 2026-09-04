// HR-ATT-ROTATING-02 — a rotating roster's rest day is not an absence.
//
// The seven EMG staff work "10am/pm – 10am/pm", two days on then one off
// (12-hour shifts). The rest day follows the ROTATION, not the calendar, so
// their schedule_pattern carries `offDays: []` — there is no weekday that is
// reliably off.
//
// absenceMarking's second guard asks resolveWorkingDays, which derives
// non-working days purely from `offDays`. With that list empty every calendar
// day reads as a scheduled working day, so every rotation rest day became an
// unpaid ABSENT.
//
// Measured against HR's final August workbook that is the entire absence gap
// for EMG: HR records 0 absences for Wajahat, Ghulam Rasool, Zubair and
// Khurram; we had raised 6, 3, 3 and 2.
//
// The rotation has no calendar anchor — nobody could say who started on days on
// 1 August — so the phase cannot be computed. What we can say is that for a
// rotating roster a day with no punch at all is indistinguishable from a rest
// day, and inventing an absence from that ambiguity is the one option that
// costs somebody money. Their real absences still surface through the anomaly
// and leave paths.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73'; // EMG
const FIXED = { id: 1, employee_code: 'EMP001', biometric_id: '3001' };
const ROTATOR = { id: 172, employee_code: 'EMP172', biometric_id: '3172' };

let employees, attendanceRows, workingMap, created;

const prismaMock = {
    employee: {
        findMany: jest.fn(async () => employees),
        count: jest.fn(async () => 0),
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
    resolveWorkingDays: jest.fn(async ({ employeeId }) =>
        employeeId === ROTATOR.id ? workingMap.rotator : workingMap.fixed,
    ),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const svc = await import('../../src/services/absenceMarking.service.js');

const DAYS = ['2026-08-10', '2026-08-11'];
// resolveWorkingDays reports a rotating roster as working-but-rotating: the
// person IS rostered, we simply cannot say which of the days is the rest day.
const fixedDays = () => new Map(DAYS.map((k) => [k, { working: true }]));
const rotatingDays = () => new Map(DAYS.map((k) => [k, { working: true, rotating: true }]));

beforeEach(() => {
    jest.clearAllMocks();
    employees = [FIXED, ROTATOR];
    attendanceRows = [];
    created = [];
    workingMap = { fixed: fixedDays(), rotator: rotatingDays() };
});

describe('HR-ATT-ROTATING-02 rotation rest days are not absences', () => {
    it('never marks a rotating employee absent for a day with no punch', async () => {
        const s = await svc.markAbsences({ tenantId: TENANT, from: DAYS[0], to: DAYS[1], dryRun: false });

        expect(created.some((c) => c.employeeId === ROTATOR.id)).toBe(false);
        expect(s.details.some((d) => d.employeeId === ROTATOR.id)).toBe(false);
    });

    it('still marks a FIXED-roster employee absent on the same days', async () => {
        // The guard must be narrow. If it suppressed everybody the absence job
        // would quietly stop working and nobody would notice for a month.
        await svc.markAbsences({ tenantId: TENANT, from: DAYS[0], to: DAYS[1], dryRun: false });

        expect(created.filter((c) => c.employeeId === FIXED.id)).toHaveLength(2);
    });

    it('counts the skipped rotating days rather than hiding them', async () => {
        const s = await svc.markAbsences({ tenantId: TENANT, from: DAYS[0], to: DAYS[1] });

        expect(s.skippedRotating).toBe(2);
    });

    it('leaves an existing attendance row on a rotating day untouched', async () => {
        // A rotating employee who DID punch keeps whatever verdict the
        // evaluator gave that day; this guard only suppresses invention.
        attendanceRows = [{ id: 9, date: new Date(`${DAYS[0]}T00:00:00.000Z`), manually_corrected: false }];

        await svc.markAbsences({ tenantId: TENANT, from: DAYS[0], to: DAYS[1], dryRun: false });

        expect(created.some((c) => c.employeeId === ROTATOR.id)).toBe(false);
    });
});

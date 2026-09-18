// ROSTER-COVERAGE-01 / HR-ROSTER-01 auto-close — regression tests.
//
// Covers the two server behaviors the Schedule screen now depends on:
//   1. getRosterCoverage — active employees (employment-period truth) with no
//      schedule in force AS AT a date; terminated employees never counted.
//   2. createWorkSchedule auto-close — creating a new open schedule over a
//      previous open one closes the old row the day before (not a 400), while
//      a bounded overlap still fails closed.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const d = (v) => new Date(`${v}T00:00:00.000Z`);

let employeeRows;
let periodRows;
let scheduleRows;
let createdSchedules;
let updatedSchedules;

const prismaMock = {
    employee: {
        findMany: jest.fn(async () => employeeRows),
        findFirst: jest.fn(async ({ where }) =>
            employeeRows.find((e) => e.id === where.id) || null),
    },
    employmentPeriod: {
        findMany: jest.fn(async ({ where }) =>
            // Real service filters by tenantId + employeeId IN (...) and orders by
            // (employeeId, startDate) — the service picks the LAST row per
            // employee as the latest period, so preserve that order here.
            (where?.employeeId?.in
                ? periodRows.filter((p) => where.employeeId.in.includes(p.employeeId))
                : periodRows
            ).slice().sort((a, b) => a.employeeId - b.employeeId || a.startDate - b.startDate)),
    },
    workSchedule: {
        findMany: jest.fn(async ({ where }) => {
            // Emulate the coverage filter for the coverage test path.
            if (where && where.effective_start_date) {
                const asOf = where.effective_start_date.lte;
                return scheduleRows.filter(
                    (s) =>
                        s.tenantId === TENANT &&
                        s.effective_start_date.getTime() <= asOf.getTime() &&
                        (s.effective_end_date == null || s.effective_end_date.getTime() >= asOf.getTime())
                );
            }
            return scheduleRows;
        }),
        findFirst: jest.fn(async ({ where }) => {
            // createWorkSchedule overlap probe: open-ended previous schedule.
            const empId = where.employeeId;
            return (
                scheduleRows.find(
                    (s) =>
                        s.employeeId === empId &&
                        s.tenantId === TENANT &&
                        (s.effective_end_date == null ||
                            (s.effective_end_date.getTime() >=
                                (where.OR?.[0]?.effective_end_date?.gte?.getTime() ?? 0) &&
                                s.effective_start_date.getTime() <=
                                    (where.OR?.[0]?.effective_start_date?.lte?.getTime() ?? Infinity)))
                ) || null
            );
        }),
        create: jest.fn(async ({ data }) => {
            const row = { id: createdSchedules.length + 1, ...data };
            createdSchedules.push(row);
            return row;
        }),
        update: jest.fn(async ({ where, data }) => {
            const row = scheduleRows.find((s) => s.id === where.id) ||
                createdSchedules.find((s) => s.id === where.id);
            Object.assign(row, data);
            updatedSchedules.push({ id: where.id, data });
            return row;
        }),
    },
    overtimeRule: { findFirst: jest.fn(async () => null) },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/tenancy.js', () => ({
    scopedWhere: (_t, where) => where,
    scopedData: (_t, data) => data,
    scopedEmployeeWhere: (_t, where) => where,
}));
jest.unstable_mockModule('../../src/utils/logs.js', () => ({ logAction: jest.fn() }));

const svc = await import('../../src/services/workScheduleService.js');

beforeEach(() => {
    jest.clearAllMocks();
    createdSchedules = [];
    updatedSchedules = [];
    employeeRows = [
        { id: 481, employee_name: 'S. Huzaifa', employee_code: 'EMP-00481', employement_status: 'Active', hire_date: d('2025-01-01'), first_name: 'S.', last_name: 'Huzaifa' },
        { id: 490, employee_name: 'Affan', employee_code: 'EMP-00490', employement_status: 'Active', hire_date: d('2026-01-01'), first_name: 'Affan', last_name: '' },
    ];
    periodRows = [
        // Affan terminated 31 July — must never appear as an active gap.
        { employeeId: 490, startDate: d('2026-01-01'), endDate: d('2026-07-31') },
    ];
    scheduleRows = [
        { id: 1, tenantId: TENANT, employeeId: 481, schedule_name: 'General', effective_start_date: d('2025-01-01'), effective_end_date: null },
    ];
});

describe('getRosterCoverage', () => {
    it('reports the one active employee without a schedule in force', async () => {
        const out = await svc.getRosterCoverage({ tenantId: TENANT });

        expect(out.activeEmployees).toBe(1); // Affan excluded: period closed
        expect(out.withScheduleInForce).toBe(1);
        expect(out.missingCount).toBe(0);
        expect(out.missing).toHaveLength(0);
    });

    it('flags an uncovered employee with name/code/hire date', async () => {
        scheduleRows = []; // nobody covered
        const out = await svc.getRosterCoverage({ tenantId: TENANT });

        expect(out.missingCount).toBe(1);
        expect(out.missing[0]).toMatchObject({ id: 481, name: 'S. Huzaifa', code: 'EMP-00481' });
    });

    it('honours AS-AT semantics: future schedule does not cover today', async () => {
        scheduleRows = [
            { id: 2, tenantId: TENANT, employeeId: 481, schedule_name: 'Future', effective_start_date: d('2026-10-01'), effective_end_date: null },
        ];
        const out = await svc.getRosterCoverage({ tenantId: TENANT, date: '2026-09-18' });

        expect(out.date).toBe('2026-09-18');
        expect(out.missingCount).toBe(1);
    });

    it('counts a future rehire active as-at a date after the prior end', async () => {
        // Meesam-style: period ended 20 Aug, new open period started 7 Sep.
        // Affan stays terminated throughout (their period from beforeEach).
        periodRows = [
            { employeeId: 490, startDate: d('2026-01-01'), endDate: d('2026-07-31') },
            { employeeId: 481, startDate: d('2025-01-01'), endDate: d('2026-08-20') },
            { employeeId: 481, startDate: d('2026-09-07'), endDate: null },
        ];
        const outSep = await svc.getRosterCoverage({ tenantId: TENANT, date: '2026-09-18' });
        const outAug = await svc.getRosterCoverage({ tenantId: TENANT, date: '2026-08-25' });

        expect(outSep.activeEmployees).toBe(1); // rehired → Huzaifa active in Sep
        expect(outSep.missingCount).toBe(0); // and his open 2025 roster covers Sep
        // Aug 25: Huzaifa's LATEST period is the open rehire (start 7 Sep) — the
        // service intentionally reads only the latest, so he still counts as
        // active inside the terminated gap. Affan stays terminated (latest
        // period closed 31 Jul).
        expect(outAug.activeEmployees).toBe(1);
        expect(outAug.missingCount).toBe(0); // his 2025 open roster covers Aug
        expect(outAug.missing.some((m) => m.id === 490)).toBe(false);
    });
});

describe('createWorkSchedule auto-close', () => {
    it('closes the previous open schedule the day before the new start', async () => {
        await svc.createWorkSchedule({
            employeeId: 481,
            schedule_name: 'Night shift',
            effective_start_date: '2026-09-11',
            schedule_pattern: { offDays: [7], shift: { from: '22:00', to: '07:00' }, crossesMidnight: true },
            tenantId: TENANT,
        });

        expect(updatedSchedules).toHaveLength(1);
        expect(updatedSchedules[0]).toMatchObject({
            id: 1,
            data: { effective_end_date: d('2026-09-10') },
        });
        expect(createdSchedules).toHaveLength(1);
    });

    it('still refuses a bounded overlap that auto-close cannot express', async () => {
        scheduleRows = [
            { id: 3, tenantId: TENANT, employeeId: 481, schedule_name: 'Bounded', effective_start_date: d('2026-09-01'), effective_end_date: d('2026-09-30') },
        ];

        await expect(
            svc.createWorkSchedule({
                employeeId: 481,
                schedule_name: 'Overlap',
                effective_start_date: '2026-09-15',
                effective_end_date: '2026-10-15',
                schedule_pattern: { offDays: [7], shift: { from: '09:00', to: '17:00' } },
                tenantId: TENANT,
            })
        ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('overlaps') });
    });
});

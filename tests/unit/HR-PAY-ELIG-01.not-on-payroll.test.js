// HR-PAY-ELIG-01 — somebody who is not on payroll is not evaluated.
//
// Sameer scans on the same device as everybody else, so the evaluator has been
// deriving his attendance, marking his absences and forecasting deductions
// against him all month. He is not on payroll. None of it means anything, and
// worse, it is noise that has repeatedly been mistaken for signal: his rows
// were the largest single block left in the reconciliation gap, and HR's sheet
// has no column for him at all — because there is nothing to reconcile.
//
// This is a general rule, not a fix for one person. Contractors, FOC staff and
// anyone else HR excludes from a payroll run should not be accumulating
// chargeable attendance rows in the meantime.
//
// The flag defaults TRUE. Attendance is the norm; exclusion is the exception
// and has to be stated, so nobody drops out of payroll by accident or by a
// migration that forgot to backfill.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 'tenant-1';
const ON_PAYROLL = 11;
const OFF_PAYROLL = 22;

let punches;
let employees;

const prismaMock = {
    attendanceDevicePunch: { findMany: jest.fn(async () => punches) },
    employee: {
        // Mirrors the real client: it filters on the ACTUAL column names, so a
        // wrong one here fails the test rather than sailing through to
        // production. Employee's tenant column is `tenant_id`, not `tenantId`.
        findMany: jest.fn(async ({ where }) => {
            const keys = Object.keys(where ?? {});
            const known = new Set(['tenant_id', 'payroll_included', 'id']);
            const unknown = keys.filter((k) => !known.has(k));
            if (unknown.length) {
                throw new Error(`unknown Employee field(s): ${unknown.join(', ')}`);
            }
            return employees.filter((e) =>
                where?.payroll_included === undefined
                || (e.payroll_included ?? true) === where.payroll_included);
        }),
        count: jest.fn(async () => 0),
    },
    workSchedule: {
        findFirst: jest.fn(async () => ({
            schedule_pattern: { type: 'weekly', offDays: [], shift: { from: '09:00', to: '18:00' } },
        })),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/services/workingDay.service.js', () => ({
    resolveWorkingDays: jest.fn(async () => new Map()),
}));

const { replayTenant } = await import('../../src/lib/attendanceReplay.js');

const at = (employeeId, hhmm) => ({
    employeeId,
    punchedAt: new Date(`2026-08-05T${hhmm}:00.000Z`),
    status: 0,
});

const run = () => replayTenant({
    tenantId: TENANT, from: '2026-08-05', to: '2026-08-05',
    policy: {}, now: new Date('2026-08-20T00:00:00.000Z'),
});

beforeEach(() => {
    jest.clearAllMocks();
    employees = [
        { id: ON_PAYROLL, payroll_included: true },
        { id: OFF_PAYROLL, payroll_included: false },
    ];
    punches = [
        at(ON_PAYROLL, '09:02'), at(ON_PAYROLL, '18:03'),
        at(OFF_PAYROLL, '09:05'), at(OFF_PAYROLL, '18:01'),
    ];
});

describe('HR-PAY-ELIG-01 employees excluded from payroll', () => {
    it('derives no attendance for someone not on payroll', async () => {
        const results = await run();

        expect(results.map((r) => r.employeeId)).not.toContain(OFF_PAYROLL);
    });

    it('still derives attendance for everyone else', async () => {
        const results = await run();

        expect(results.map((r) => r.employeeId)).toContain(ON_PAYROLL);
    });

    it('keeps evaluating when nobody is excluded', async () => {
        employees = [
            { id: ON_PAYROLL, payroll_included: true },
            { id: OFF_PAYROLL, payroll_included: true },
        ];

        const results = await run();

        expect(results).toHaveLength(2);
    });

    it('treats a missing flag as included, never as excluded', async () => {
        // Rows predating the column, or any backfill that missed somebody, must
        // not silently stop being paid.
        employees = [{ id: ON_PAYROLL }, { id: OFF_PAYROLL }];

        const results = await run();

        expect(results).toHaveLength(2);
    });

    it('does not delete the punches of an excluded employee', async () => {
        await run();

        // They keep scanning on the shared device; the raw record stays intact
        // so re-including them recovers their history.
        expect(prismaMock.attendanceDevicePunch.delete).toBeUndefined();
        expect(prismaMock.attendanceDevicePunch.deleteMany).toBeUndefined();
    });
});

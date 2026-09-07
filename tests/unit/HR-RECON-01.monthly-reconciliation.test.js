// HR-RECON-01 — HR closes the month without needing me.
//
// Every number quoted this month came from a comparison script in a scratchpad
// directory: export the rows, match names against the workbook, count. It found
// real defects, but it is not a feature — nobody else can run it, and it dies
// with the session.
//
// The report is only now possible. Until HR-ATT-STATUS-01 an off day was an
// ABSENT row or no row at all, so "expected working days" had to be guessed —
// getAttendanceSummaryWeekly still assumes Mon-Sat for everyone, which the
// roster work disproved (Tue+Fri, Tue+Wed+Thu, and 3-day rotations that walk
// through the week). With WEEKLY_OFF, HOLIDAY and ON_LEAVE asserted, the
// denominator is DERIVED: expected = days that are not one of those.
//
// What HR needs to close a month, per employee: what they were credited, what
// is still blocking, and what a human already ruled on — so the argument is
// about the exceptions, not about the arithmetic.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 'tenant-1';
let rows;
let employees;

const prismaMock = {
    attendance: { findMany: jest.fn(async () => rows) },
    employee: { findMany: jest.fn(async () => employees) },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/tenancy.js', () => ({
    scopedWhere: (_t, w) => w,
    scopedEmployeeWhere: (_t, w) => w,
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { buildMonthlyReconciliation } = await import(
    '../../src/services/attendanceReconciliation.service.js'
);

const row = (employeeId, date, status, over = {}) => ({
    employeeId, date: new Date(`${date}T00:00:00.000Z`), status,
    manually_corrected: false, requires_regularization: false, day_credit: null, ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    employees = [
        { id: 1, employee_code: 'EMP001', employee_name: 'Ali' },
        { id: 2, employee_code: 'EMP002', employee_name: 'Sara' },
    ];
    rows = [];
});

const run = () => buildMonthlyReconciliation({
    tenantId: TENANT, from: '2026-08-01', to: '2026-08-31',
});

describe('HR-RECON-01 monthly reconciliation', () => {
    it('counts each status per employee', async () => {
        rows = [
            row(1, '2026-08-03', 'PRESENT'),
            row(1, '2026-08-04', 'LATE'),
            row(1, '2026-08-05', 'ABSENT'),
            row(1, '2026-08-08', 'WEEKLY_OFF'),
        ];

        const { employees: out } = await run();
        const ali = out.find((e) => e.employeeCode === 'EMP001');

        expect(ali.present).toBe(1);
        expect(ali.late).toBe(1);
        expect(ali.absent).toBe(1);
        expect(ali.weeklyOff).toBe(1);
    });

    it('derives expected working days from the asserted off-days', async () => {
        // Not "Mon-Sat" — this employee's roster is whatever the stored rows
        // say it was. Four days, one of them off, so three were expected.
        rows = [
            row(1, '2026-08-03', 'PRESENT'),
            row(1, '2026-08-04', 'PRESENT'),
            row(1, '2026-08-05', 'ABSENT'),
            row(1, '2026-08-06', 'WEEKLY_OFF'),
        ];

        const ali = (await run()).employees.find((e) => e.employeeCode === 'EMP001');

        expect(ali.expectedDays).toBe(3);
        expect(ali.attendancePct).toBe(67); // 2 of 3
    });

    it('does not count a holiday or approved leave as an expected day', async () => {
        rows = [
            row(1, '2026-08-03', 'PRESENT'),
            row(1, '2026-08-14', 'HOLIDAY'),
            row(1, '2026-08-20', 'ON_LEAVE'),
        ];

        const ali = (await run()).employees.find((e) => e.employeeCode === 'EMP001');

        expect(ali.expectedDays).toBe(1);
        expect(ali.holiday).toBe(1);
        expect(ali.onLeave).toBe(1);
    });

    it('surfaces the days still blocking payroll', async () => {
        rows = [
            row(1, '2026-08-03', 'MISSING_CHECKOUT', { requires_regularization: true }),
            row(1, '2026-08-04', 'MISSING_CHECKIN', { requires_regularization: true }),
            row(1, '2026-08-05', 'PRESENT'),
        ];

        const res = await run();
        const ali = res.employees.find((e) => e.employeeCode === 'EMP001');

        expect(ali.missingCheckout).toBe(1);
        expect(ali.missingCheckin).toBe(1);
        expect(ali.needsReview).toBe(2);
        expect(res.totals.needsReview).toBe(2);
    });

    it('separates what a human already ruled on', async () => {
        rows = [
            row(1, '2026-08-03', 'PRESENT', { manually_corrected: true }),
            row(1, '2026-08-04', 'PRESENT'),
        ];

        const ali = (await run()).employees.find((e) => e.employeeCode === 'EMP001');

        expect(ali.corrected).toBe(1);
    });

    it('lists an employee with no rows at all rather than omitting them', async () => {
        // Somebody with a blank month is the single most important row in a
        // reconciliation. Dropping them is how a person goes unpaid quietly.
        rows = [row(1, '2026-08-03', 'PRESENT')];

        const out = (await run()).employees;

        expect(out.map((e) => e.employeeCode)).toContain('EMP002');
        const sara = out.find((e) => e.employeeCode === 'EMP002');
        expect(sara.expectedDays).toBe(0);
        expect(sara.noData).toBe(true);
    });

    it('totals across the tenant', async () => {
        rows = [
            row(1, '2026-08-03', 'PRESENT'),
            row(2, '2026-08-03', 'ABSENT'),
            row(2, '2026-08-04', 'WEEKLY_OFF'),
        ];

        const { totals } = await run();

        expect(totals.present).toBe(1);
        expect(totals.absent).toBe(1);
        expect(totals.weeklyOff).toBe(1);
        expect(totals.employees).toBe(2);
    });

    it('never divides by zero', async () => {
        rows = [row(1, '2026-08-08', 'WEEKLY_OFF')];

        const ali = (await run()).employees.find((e) => e.employeeCode === 'EMP001');

        expect(ali.expectedDays).toBe(0);
        expect(ali.attendancePct).toBe(0);
    });
});

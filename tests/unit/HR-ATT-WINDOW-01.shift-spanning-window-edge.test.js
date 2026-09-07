// HR-ATT-WINDOW-01 — a shift that starts before the window still has a start.
//
// replayTenant reads punches strictly inside [from, to]. Shifts do not respect
// that boundary: a night shift beginning 31 July at 22:00 and ending 1 August
// at 10:00 has its check-IN outside an August window and its check-OUT inside.
//
// The lone OUT then opens a session of its own on 1 August and evaluates to
// MISSING_CHECKOUT — a shift nobody failed to close, invented by the query
// range. Measured on production August data: 8 of the 37 rows on 08-01 were
// MISSING_CHECKOUT (22%), against 0-5% on every other day of the month.
//
// It is not cosmetic. MISSING_* is written with day_credit NULL and
// requires_regularization set, so payroll HOLDS the day rather than paying it.
// A month boundary silently parks a day's pay for everyone on nights.
//
// So the punch query reaches a day either side, and sessions are then filtered
// back to the requested window — the extra day exists to complete shifts that
// belong to the window, not to create rows outside it.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 'tenant-1';
const EMPLOYEE = 42;

// Every punch the "device" holds. Two night shifts, one hanging off each edge
// of the requested window: the first starts the evening BEFORE `from`, the last
// ends the morning AFTER `to`.
const ALL_PUNCHES = [
    { employeeId: EMPLOYEE, punchedAt: new Date('2026-07-31T22:04:00.000Z'), status: 0 },
    { employeeId: EMPLOYEE, punchedAt: new Date('2026-08-01T10:02:00.000Z'), status: 1 },
    { employeeId: EMPLOYEE, punchedAt: new Date('2026-08-02T22:05:00.000Z'), status: 0 },
    { employeeId: EMPLOYEE, punchedAt: new Date('2026-08-03T10:01:00.000Z'), status: 1 },
];

let queriedRange;

const prismaMock = {
    // Honours the where-clause, so a query that fails to widen its range simply
    // does not see the 31 July arrival — exactly as production behaves.
    attendanceDevicePunch: {
        findMany: jest.fn(async ({ where }) => {
            queriedRange = where.punchedAt;
            return ALL_PUNCHES.filter(
                (p) => p.punchedAt >= where.punchedAt.gte && p.punchedAt <= where.punchedAt.lte,
            );
        }),
    },
    // HR-PAY-ELIG-01 asks for the payroll-excluded list; nobody is excluded here.
    employee: { findMany: jest.fn(async () => []) },
    workSchedule: {
        findFirst: jest.fn(async () => ({
            schedule_pattern: {
                type: 'weekly',
                offDays: [],
                shift: { from: '22:00', to: '10:00' },
            },
        })),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/services/workingDay.service.js', () => ({
    resolveWorkingDays: jest.fn(async () => new Map()),
}));

const { replayTenant } = await import('../../src/lib/attendanceReplay.js');

const run = () =>
    replayTenant({
        tenantId: TENANT,
        from: '2026-08-01',
        to: '2026-08-02',
        policy: {},
        now: new Date('2026-08-10T00:00:00.000Z'),
    });

beforeEach(() => { jest.clearAllMocks(); queriedRange = null; });

describe('HR-ATT-WINDOW-01 shifts spanning the window edge', () => {
    it('reads punches from before the window so the shift keeps its check-in', async () => {
        await run();

        expect(queriedRange.gte.getTime())
            .toBeLessThanOrEqual(new Date('2026-07-31T22:04:00.000Z').getTime());
    });

    it('does not invent a MISSING_CHECKOUT at either edge', async () => {
        // The 31 July arrival now completes its own shift, so nothing is left
        // stranded on 1 August — and no shift anywhere in the window reads as
        // unclosed, because every one of them has both ends.
        const results = await run();

        expect(results.map((r) => r.verdict.status)).not.toContain('MISSING_CHECKOUT');
    });

    it('does not emit a row for the day before the window', async () => {
        // The extra day completes shifts; it must not produce attendance of its
        // own, or a re-run would write July rows into an August roll-up.
        const results = await run();

        expect(results.map((r) => r.day.toISOString().slice(0, 10)))
            .not.toContain('2026-07-31');
    });

    it('completes a shift that runs off the far edge of the window', async () => {
        // Starts 2 August inside the window, ends 3 August outside it. The day
        // belongs to the window, so the row is written — with its check-out.
        const results = await run();

        const last = results.find((r) => r.day.toISOString().slice(0, 10) === '2026-08-02');
        expect(last).toBeDefined();
        expect(last.verdict.checkOut).toBeTruthy();
    });
});

// HR-ROSTER-02 — a roster change is a new version, never an edit.
//
// Today a weekend is changed by rewriting schedule_pattern in place. With
// HR-ROSTER-01 resolving the roster per day, that is now actively dangerous:
// the new pattern inherits the old row's effective_start_date and therefore
// applies to every day that row ever covered. Correcting someone's weekend in
// September would silently re-derive August, and August is closed.
//
// The rule: changing a roster FROM a date closes the row covering that date on
// the day before, and inserts a new row starting on it. Ranges never overlap
// and never leave a gap, so exactly one schedule governs any given day.
//
// The exception is a CORRECTION. When the new range starts on the same day as
// the existing row, the old row would be left covering nothing — a zero-length
// version that is noise in the history and a trap for any query that assumes
// ranges are non-empty. The stored value was simply wrong for its whole life,
// so the row is replaced in place and the previous pattern is kept in the note.
// This is the case for the four Homenet rosters HR corrected with effect from
// 1 August, which is also the day their only schedule row begins.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const EMPLOYEE = 601;
const d = (v) => new Date(`${v}T00:00:00.000Z`);
const iso = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

let rows;
let nextId;

const prismaMock = {
    workSchedule: {
        findMany: jest.fn(async () => [...rows].sort(
            (a, b) => b.effective_start_date - a.effective_start_date,
        )),
        update: jest.fn(async ({ where, data }) => {
            const row = rows.find((r) => r.id === where.id);
            Object.assign(row, data);
            return row;
        }),
        create: jest.fn(async ({ data }) => {
            // Mirrors the real client: WorkSchedule.schedule_name and
            // total_hours_per_week are NOT NULL with no default. A mock that
            // accepts anything let a create ship that Postgres refused —
            // "Argument `schedule_name` is missing" — on the first roster
            // change that actually took the versioned path.
            for (const required of ['schedule_name', 'total_hours_per_week',
                'employeeId', 'effective_start_date']) {
                if (data[required] === undefined || data[required] === null) {
                    throw new Error(`Argument \`${required}\` is missing.`);
                }
            }
            nextId += 1;
            const row = { id: nextId, ...data };
            rows.push(row);
            return row;
        }),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_c, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { changeRoster } = await import('../../src/services/rosterChange.service.js');

const OLD = { offDays: [6, 7], shift: { from: '09:00', to: '18:00' } };
const NEW = { offDays: [2, 5], shift: { from: '09:00', to: '18:00' } };

beforeEach(() => {
    jest.clearAllMocks();
    nextId = 100;
    rows = [{
        id: 100,
        employeeId: EMPLOYEE,
        tenantId: 't1',
        schedule_name: 'Device roster 2026-08',
        total_hours_per_week: 45,
        schedule_pattern: OLD,
        effective_start_date: d('2026-08-01'),
        effective_end_date: null,
    }];
});

const change = (from, opts = {}) => changeRoster({
    employeeId: EMPLOYEE, tenantId: 't1', effectiveFrom: from,
    pattern: NEW, reason: 'HR: weekend corrected', ...opts,
});

describe('HR-ROSTER-02 roster versioning', () => {
    it('closes the current version the day before the change', async () => {
        await change('2026-09-01');

        const old = rows.find((r) => r.id === 100);
        expect(iso(old.effective_end_date)).toBe('2026-08-31');
        expect(old.schedule_pattern).toEqual(OLD);
    });

    it('inserts the new version starting on the effective date', async () => {
        await change('2026-09-01');

        const fresh = rows.find((r) => r.id !== 100);
        expect(iso(fresh.effective_start_date)).toBe('2026-09-01');
        expect(fresh.effective_end_date).toBeNull();
        expect(fresh.schedule_pattern.offDays).toEqual([2, 5]);
    });

    it('leaves no overlap and no gap between versions', async () => {
        await change('2026-09-01');

        const sorted = [...rows].sort((a, b) => a.effective_start_date - b.effective_start_date);
        for (let i = 0; i < sorted.length - 1; i += 1) {
            const gap = sorted[i + 1].effective_start_date - sorted[i].effective_end_date;
            expect(gap).toBe(86_400_000); // exactly one day: contiguous, not overlapping
        }
    });

    it('does not touch the pattern the old version carried', async () => {
        // The whole point: August keeps being read with August's roster.
        await change('2026-09-01');

        expect(rows.find((r) => r.id === 100).schedule_pattern).toEqual(OLD);
    });

    it('replaces in place when the change starts on the version it would close', async () => {
        // A correction, not a change — the stored value was wrong for the row's
        // entire life, so no zero-length version is created.
        await change('2026-08-01');

        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(100);
        expect(rows[0].schedule_pattern.offDays).toEqual([2, 5]);
        expect(iso(rows[0].effective_start_date)).toBe('2026-08-01');
    });

    it('keeps what a correction overwrote, so it is not lost', async () => {
        await change('2026-08-01');

        expect(JSON.stringify(rows[0].schedule_pattern.supersedes)).toContain('6');
        expect(rows[0].schedule_pattern.changeReason).toBe('HR: weekend corrected');
    });

    it('creates a first version when the employee has no schedule', async () => {
        rows = [];
        await change('2026-08-01', { scheduleName: 'Standard', totalHoursPerWeek: 40 });

        expect(rows).toHaveLength(1);
        expect(iso(rows[0].effective_start_date)).toBe('2026-08-01');
        expect(rows[0].effective_end_date).toBeNull();
    });

    it('refuses a change that would start before the history it rewrites', async () => {
        // Backdating before the earliest version has no honest meaning: the
        // days in between were derived under a roster that never existed.
        await expect(change('2026-07-01')).rejects.toThrow(/before/i);
    });

    it('carries the required columns onto the new version', async () => {
        // schedule_name and total_hours_per_week are NOT NULL with no default.
        // Inheriting them from the version being closed is the only honest
        // source: inventing weekly hours would be inventing a number that
        // feeds pay.
        await change('2026-09-01');

        const fresh = rows.find((r) => r.id !== 100);
        expect(fresh.schedule_name).toBe('Device roster 2026-08');
        expect(fresh.total_hours_per_week).toBe(45);
    });

    it('refuses a first version with no hours to inherit', async () => {
        // Nothing to carry forward and nothing supplied. Defaulting the hours
        // would put a made-up number where payroll reads one.
        rows = [];

        await expect(change('2026-08-01')).rejects.toThrow(/total_hours_per_week|schedule_name/i);
    });

    it('accepts them explicitly when there is no prior version', async () => {
        rows = [];

        await change('2026-08-01', { scheduleName: 'Standard', totalHoursPerWeek: 40 });

        expect(rows[0].schedule_name).toBe('Standard');
        expect(rows[0].total_hours_per_week).toBe(40);
    });

    it('records who and why on the new version', async () => {
        await change('2026-09-01', { changedBy: 'moeez' });

        const fresh = rows.find((r) => r.id !== 100);
        expect(fresh.schedule_pattern.changeReason).toBe('HR: weekend corrected');
        expect(fresh.schedule_pattern.changedBy).toBe('moeez');
    });
});

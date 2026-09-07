// HR-ATT-CORRECTION-02 — a correction records what it changed, and who by.
//
// correctAttendanceDay already attributes: corrected_by_id, corrected_at,
// correction_reason on the row, plus a Log entry. What it does not record is
// the BEFORE state. The Log note carries the new values only — "status=PRESENT
// credit=1 — HR sheet" does not say what the day used to be, so nobody can tell
// whether a correction moved a day from ABSENT to PRESENT (a day's pay) or
// merely tidied a check-out minute. Reconstructing it means diffing backups.
//
// Measured on production August data: 263 manually_corrected rows, 221
// attributed, and 42 carrying only a free-text `remarks` string — no author, no
// timestamp, no Log row. Those 42 are the HR-sheet fills applied by one-off
// scripts, which set manually_corrected directly. The service existed; the
// scripts went around it.
//
// Both halves are the same defect: a correction is data, and data that records
// only its outcome is not auditable. `manually_corrected` says THAT something
// changed; it has to say what, from what, and by whom.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 'tenant-1';
const ACTOR = 214;
const EMPLOYEE = 90;

let existingRow;
let logs;
let updates;

const prismaMock = {
    employee: {
        findFirst: jest.fn(async () => ({ id: EMPLOYEE, tenant_id: TENANT, work_mode: null })),
        findUnique: jest.fn(async () => ({ id: EMPLOYEE, tenant_id: TENANT, work_mode: null })),
    },
    attendance: {
        findFirst: jest.fn(async () => existingRow),
        update: jest.fn(async ({ where, data }) => {
            updates.push({ id: where.id, ...data });
            return { id: where.id, ...existingRow, ...data };
        }),
        create: jest.fn(async ({ data }) => { updates.push(data); return { id: 999, ...data }; }),
    },
    log: { create: jest.fn(async ({ data }) => { logs.push(data); return data; }) },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_c, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { correctAttendanceDay } = await import('../../src/services/attendanceCorrection.service.js');

beforeEach(() => {
    jest.clearAllMocks();
    logs = [];
    updates = [];
    existingRow = {
        id: 55,
        employeeId: EMPLOYEE,
        date: new Date('2026-08-14T00:00:00.000Z'),
        status: 'ABSENT',
        check_in: null,
        check_out: null,
        total_hours: null,
        day_credit: 0,
    };
});

const correct = (over = {}) => correctAttendanceDay({
    tenantId: TENANT,
    employeeId: EMPLOYEE,
    date: '2026-08-14',
    checkIn: '09:00',
    checkOut: '18:00',
    status: 'PRESENT',
    reason: 'HR sheet: worked the holiday',
    actorEmployeeId: ACTOR,
    ...over,
});

describe('HR-ATT-CORRECTION-02 corrections record before and after', () => {
    it('records what the day WAS, not only what it became', async () => {
        await correct();

        const note = logs[0].notes;
        expect(note).toContain('ABSENT');   // the previous status
        expect(note).toContain('PRESENT');  // the new one
    });

    it('shows the previous times too, so a minute-level fix is visible', async () => {
        existingRow = {
            ...existingRow,
            status: 'LATE',
            check_in: new Date('2026-08-14T09:41:00.000Z'),
        };

        await correct();

        expect(logs[0].notes).toContain('09:41');
    });

    it('still attributes the correction on the row', async () => {
        await correct();

        const row = updates[0];
        expect(row.corrected_by_id).toBe(ACTOR);
        expect(row.correction_reason).toBe('HR sheet: worked the holiday');
        expect(row.corrected_at).toBeInstanceOf(Date);
        expect(row.manually_corrected).toBe(true);
    });

    it('says "created" rather than inventing a previous state', async () => {
        // A day that had no row at all has no "before". Claiming it changed
        // FROM something would be a fabrication.
        existingRow = null;

        await correct();

        expect(logs[0].action_type).toBe('ATTENDANCE_CREATED_MANUALLY');
        expect(logs[0].notes).not.toContain('was ');
    });

    it('keeps refusing an unexplained correction', async () => {
        await expect(correct({ reason: '   ' })).rejects.toThrow();
    });
});

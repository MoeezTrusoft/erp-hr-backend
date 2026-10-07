// HR-ATT-PAID-NOPUNCH-01 — a standing paid-without-punches roster.
//
// Jamshed Ur Rehman (Homenet, operator request 2026-10-07) works Mon–Thu with
// no device punches at all, on a full salary. The nightly marker previously
// charged every un-punched scheduled day ABSENT (unpaid) and HR hand-corrected
// each month — September was fixed by hand, October started charging again.
// The roster now carries schedule_pattern.paidWithoutPunches, the working-day
// resolver brands scheduled days PAID_NO_PUNCH, and the marker writes a
// credited PRESENT instead of an absence. The ordinary no-show path is
// untouched: without the flag nothing changes.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '8ff0533b-62f6-4be9-a78e-69adf49e00bc';
const EMP = { id: 511, employee_code: 'EMP-00511', biometric_id: '511' };

let employees, unenrolledCount, attendanceRows, workingMap;
const created = [];
const updated = [];

const prismaMock = {
    employee: {
        findMany: jest.fn(async () => employees),
        count: jest.fn(async () => unenrolledCount),
    },
    employmentPeriod: {
        findMany: jest.fn(async () => []),
    },
    attendance: {
        findMany: jest.fn(async () => attendanceRows),
        create: jest.fn(async ({ data }) => { created.push(data); return { id: created.length, ...data }; }),
        update: jest.fn(async ({ data }) => { updated.push(data); return { id: 9, ...data }; }),
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

beforeEach(() => {
    jest.clearAllMocks();
    created.length = 0;
    updated.length = 0;
    employees = [EMP];
    unenrolledCount = 0;
    attendanceRows = [];
    workingMap = new Map([
        // Mon 5th: paid-no-punch scheduled day (the flag is on the roster).
        ['2026-10-05', { working: true, reason: 'PAID_NO_PUNCH' }],
        // Tue 6th: an ordinary scheduled day (no flag) — must stay a no-show.
        ['2026-10-06', { working: true, reason: null }],
    ]);
});

describe('HR-ATT-PAID-NOPUNCH-01', () => {
    it('credits a missing paid-no-punch day as PRESENT, not ABSENT', async () => {
        const s = await svc.markAbsences({ tenantId: TENANT, from: '2026-10-05', to: '2026-10-05', dryRun: false });

        expect(s.marked).toBe(1);
        expect(created).toHaveLength(1);
        expect(created[0].status).toBe('PRESENT');
        expect(created[0].day_credit).toBe(1);
        expect(created[0].requires_regularization).toBe(false);
        expect(created[0].remarks).toMatch(/paid day, no punch recorded/i);
    });

    it('restates a stale automatic ABSENT to a paid PRESENT', async () => {
        // Oct 5 was charged ABSENT by an earlier run before the roster flag
        // existed. An automatic row is not an HR ruling — fix it.
        attendanceRows = [{ id: 9, date: day('2026-10-05'), status: 'ABSENT', manually_corrected: false }];

        await svc.markAbsences({ tenantId: TENANT, from: '2026-10-05', to: '2026-10-05', dryRun: false });

        expect(updated).toHaveLength(1);
        expect(updated[0].status).toBe('PRESENT');
        expect(updated[0].day_credit).toBe(1);
    });

    it('still marks an ordinary no-show ABSENT (no flag, nothing changes)', async () => {
        const s = await svc.markAbsences({ tenantId: TENANT, from: '2026-10-06', to: '2026-10-06', dryRun: false });

        expect(s.marked).toBe(1);
        expect(created).toHaveLength(1);
        expect(created[0].status).toBe('ABSENT');
        expect(created[0].day_credit).toBe(0);
        expect(created[0].requires_regularization).toBe(true);
    });

    it('never touches a manually corrected day on a paid-no-punch roster', async () => {
        attendanceRows = [{ id: 9, date: day('2026-10-05'), status: 'PRESENT', manually_corrected: true }];

        const s = await svc.markAbsences({ tenantId: TENANT, from: '2026-10-05', to: '2026-10-05' });

        expect(s.manuallyCorrected).toBe(1);
        expect(updated).toHaveLength(0);
        expect(created).toHaveLength(0);
    });
});

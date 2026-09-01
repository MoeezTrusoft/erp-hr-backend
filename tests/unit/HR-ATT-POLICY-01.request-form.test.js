// HR-ATT-POLICY-01 — the regularization request form.
//
// The employee types ONE field. Everything else is derived, and the derivation
// is what these tests protect:
//   * category comes off the attendance day, never from the client, so a
//     forgotten check-out cannot be filed as a cheaper "late";
//   * position/department are snapshots taken at raise time;
//   * one open request per employee-day, or the same day gets two outcomes and
//     downstream, two deductions.
// Runs under TZ=UTC, pinned by the jest scripts.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const EMP = 100;
const DAY = '2026-08-14';

let attendanceRow;
let schedule;
let anomalyRows;
let created;

const routeAnomalyMock = jest.fn(async () => ({ routed: true, level: 1, approverId: 200 }));

const prismaMock = {
    employee: {
        findUnique: jest.fn(async () => ({
            id: EMP,
            employee_code: 'EMP100',
            employee_name: null,
            first_name: 'Asad',
            last_name: 'Ullah',
            job_title: 'Support Engineer',
            businessUnit: { name: 'Operations' },
            Position: { title: 'Senior Support Engineer' },
        })),
    },
    workSchedule: { findFirst: jest.fn(async () => schedule) },
    attendance: { findFirst: jest.fn(async () => attendanceRow) },
    attendanceAnomaly: {
        findFirst: jest.fn(async () => anomalyRows[0] ?? null),
        create: jest.fn(async ({ data }) => { created = { id: 1, ...data }; return created; }),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_c, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/services/attendanceAnomalyRouting.service.js', () => ({
    routeAnomaly: routeAnomalyMock,
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const form = await import('../../src/services/attendanceAnomalyRequest.service.js');

beforeEach(() => {
    jest.clearAllMocks();
    created = null;
    anomalyRows = [];
    attendanceRow = null;
    schedule = { schedule_pattern: { shift: { from: '10:00', to: '18:00' } } };
});

describe('HR-ATT-POLICY-01 form defaults', () => {
    it('fills everything except reason', async () => {
        const d = await form.getAnomalyFormDefaults({ tenantId: TENANT, employeeId: EMP, date: DAY });

        expect(d.applicant.name).toBe('Asad Ullah');       // employee_name is null here
        expect(d.position).toBe('Senior Support Engineer'); // linked Position wins over job_title
        expect(d.department).toBe('Operations');
        expect(d.leaveDate.getDate()).toBe(14);
        expect(d.reason).toBeNull();                        // the only blank
    });

    it('spans the whole shift when there is no attendance at all', async () => {
        const d = await form.getAnomalyFormDefaults({ tenantId: TENANT, employeeId: EMP, date: DAY });

        expect(d.category).toBe('ABSENT');
        expect(d.fromTime.getHours()).toBe(10);
        expect(d.toTime.getHours()).toBe(18);
    });

    it('spans expected -> actual arrival for a late day', async () => {
        attendanceRow = { status: 'LATE', check_in: new Date('2026-08-14T10:42:00Z'), check_out: null };

        const d = await form.getAnomalyFormDefaults({ tenantId: TENANT, employeeId: EMP, date: DAY });

        expect(d.category).toBe('LATE_CHECKIN');
        expect(d.expectedTime.getHours()).toBe(10);
        expect(d.actualTime.getMinutes()).toBe(42);
    });

    it('spans check-in -> shift end for a missing check-out', async () => {
        attendanceRow = { status: 'MISSING_CHECKOUT', check_in: new Date('2026-08-14T10:02:00Z'), check_out: null };

        const d = await form.getAnomalyFormDefaults({ tenantId: TENANT, employeeId: EMP, date: DAY });

        expect(d.category).toBe('MISSING_CHECKOUT');
        expect(d.fromTime.getHours()).toBe(10);
        expect(d.toTime.getHours()).toBe(18);
    });

    it('carries a night shift end into the next day', async () => {
        schedule = { schedule_pattern: { shift: { from: '22:00', to: '08:00' } } };

        const d = await form.getAnomalyFormDefaults({ tenantId: TENANT, employeeId: EMP, date: DAY });

        // Without the wrap the window would run backwards and every night
        // worker's request would look malformed.
        expect(d.toTime.getTime()).toBeGreaterThan(d.fromTime.getTime());
        expect(d.toTime.getDate()).toBe(15);
    });

    it('degrades to a null window when the employee has no rostered shift', async () => {
        // 16 employees are rotating/roster-only with no fixed clock range.
        schedule = null;

        const d = await form.getAnomalyFormDefaults({ tenantId: TENANT, employeeId: EMP, date: DAY });

        expect(d.category).toBe('ABSENT');
        expect(d.fromTime).toBeNull();
        expect(d.toTime).toBeNull();
    });
});

describe('HR-ATT-POLICY-01 submission', () => {
    it('requires a reason', async () => {
        await expect(
            form.createAnomalyRequest({ tenantId: TENANT, employeeId: EMP, date: DAY, reason: '   ' }),
        ).rejects.toThrow('reason is required');
    });

    it('re-derives the category server-side and snapshots position/department', async () => {
        attendanceRow = { status: 'MISSING_CHECKOUT', check_in: new Date('2026-08-14T10:02:00Z'), check_out: null };

        await form.createAnomalyRequest({
            tenantId: TENANT, employeeId: EMP, date: DAY, reason: 'forgot to scan out',
        });

        expect(created.type).toBe('MISSING_CHECKOUT');
        expect(created.positionSnapshot).toBe('Senior Support Engineer');
        expect(created.departmentSnapshot).toBe('Operations');
        expect(created.reason).toBe('forgot to scan out');
        expect(created.sourceKind).toBe('REGULARIZATION');
        expect(created.sourceRef).toBe(`regularization:${EMP}:2026-08-14`);
    });

    it('routes the request after creating it', async () => {
        await form.createAnomalyRequest({ tenantId: TENANT, employeeId: EMP, date: DAY, reason: 'x' });

        expect(routeAnomalyMock).toHaveBeenCalledWith({ tenantId: TENANT, anomalyId: 1 });
    });

    it('refuses a second request while one is pending for that day', async () => {
        anomalyRows = [{ id: 5, status: 'PENDING' }];

        await expect(
            form.createAnomalyRequest({ tenantId: TENANT, employeeId: EMP, date: DAY, reason: 'again' }),
        ).rejects.toThrow('already pending');
    });

    it('refuses to re-file a day that was already decided', async () => {
        anomalyRows = [{ id: 5, status: 'REJECTED' }];

        await expect(
            form.createAnomalyRequest({ tenantId: TENANT, employeeId: EMP, date: DAY, reason: 'again' }),
        ).rejects.toThrow('already REJECTED');
    });
});

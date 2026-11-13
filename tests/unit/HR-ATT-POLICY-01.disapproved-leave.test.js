// HR-ATT-POLICY-01 — disapproved leave, from both sources, without double-billing.
//
// A rejected LeaveRequest and a rejected regularization can describe the SAME
// unpaid day. Counting it twice deducts twice from someone's salary, so the
// dedup is the whole point of this module and gets the coverage.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const EMP = 100;
const OTHER = 101;

let leaveRequests;
let anomalies;
let createdRows;

const prismaMock = {
    leaveRequest: { findMany: jest.fn(async () => leaveRequests) },
    attendanceAnomaly: {
        findFirst: jest.fn(async ({ where }) =>
            anomalies.find(
                (a) =>
                    a.employeeId === where.employeeId &&
                    a.status === where.status &&
                    a.date.getTime() === where.date.getTime(),
            ) ?? null,
        ),
        findMany: jest.fn(async () => anomalies),
        create: jest.fn(async ({ data }) => {
            createdRows.push(data);
            anomalies.push({ ...data });
            return { id: createdRows.length, ...data };
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

const svc = await import('../../src/services/disapprovedLeave.service.js');

const d = (s) => { const x = new Date(s); x.setHours(0, 0, 0, 0); return x; };

beforeEach(() => {
    jest.clearAllMocks();
    createdRows = [];
    anomalies = [];
    leaveRequests = [];
});

describe('HR-ATT-POLICY-01 generation from rejected leave', () => {
    it('creates one marker per day of a rejected multi-day request', async () => {
        leaveRequests = [{ id: 7, employeeId: EMP, startDate: d('2026-08-10'), endDate: d('2026-08-12') }];

        const s = await svc.generateDisapprovedLeaveAnomalies({ tenantId: TENANT });

        expect(s.created).toBe(3);
        expect(createdRows.map((r) => r.sourceRef)).toEqual([
            'leaveRequest:7:2026-08-10',
            'leaveRequest:7:2026-08-11',
            'leaveRequest:7:2026-08-12',
        ]);
        // Recorded as already-refused, not as a request awaiting a decision.
        expect(createdRows.every((r) => r.status === 'REJECTED')).toBe(true);
    });

    it('does NOT re-create a day that already carries a rejected regularization', async () => {
        anomalies = [{
            employeeId: EMP, date: d('2026-08-11'), status: 'REJECTED',
            sourceKind: 'REGULARIZATION', sourceRef: `regularization:${EMP}:2026-08-11`,
        }];
        leaveRequests = [{ id: 7, employeeId: EMP, startDate: d('2026-08-10'), endDate: d('2026-08-12') }];

        const s = await svc.generateDisapprovedLeaveAnomalies({ tenantId: TENANT });

        // The 11th already has a rejection from the other source.
        expect(s.created).toBe(2);
        expect(s.skippedExisting).toBe(1);
        expect(createdRows.map((r) => r.sourceRef)).not.toContain('leaveRequest:7:2026-08-11');
    });

    it('is a no-op on re-run', async () => {
        leaveRequests = [{ id: 7, employeeId: EMP, startDate: d('2026-08-10'), endDate: d('2026-08-10') }];

        await svc.generateDisapprovedLeaveAnomalies({ tenantId: TENANT });
        createdRows = [];
        const second = await svc.generateDisapprovedLeaveAnomalies({ tenantId: TENANT });

        expect(second.created).toBe(0);
        expect(createdRows).toHaveLength(0);
    });

    it('treats a unique-index collision as already-done, not a failure', async () => {
        // Two generator runs racing: the index is the real guard.
        leaveRequests = [{ id: 7, employeeId: EMP, startDate: d('2026-08-10'), endDate: d('2026-08-10') }];
        prismaMock.attendanceAnomaly.create.mockRejectedValueOnce(
            Object.assign(new Error('unique constraint'), { code: 'P2002' }),
        );

        const s = await svc.generateDisapprovedLeaveAnomalies({ tenantId: TENANT });

        expect(s.created).toBe(0);
        expect(s.skippedExisting).toBe(1);
    });

    it('ignores a reversed date range instead of looping', async () => {
        leaveRequests = [{ id: 9, employeeId: EMP, startDate: d('2026-08-12'), endDate: d('2026-08-10') }];

        const s = await svc.generateDisapprovedLeaveAnomalies({ tenantId: TENANT });

        expect(s.days).toBe(0);
        expect(s.created).toBe(0);
    });
});

describe('HR-ATT-POLICY-01 countable days', () => {
    it('counts ONE occurrence when both sources reject the same day', async () => {
        anomalies = [
            { id: 1, employeeId: EMP, date: d('2026-08-11'), status: 'REJECTED', sourceKind: 'REGULARIZATION', type: 'ABSENT' },
            { id: 2, employeeId: EMP, date: d('2026-08-11'), status: 'REJECTED', sourceKind: 'LEAVE_REQUEST', type: 'ABSENT' },
        ];

        const days = await svc.listDisapprovedLeaveDays({
            tenantId: TENANT, from: '2026-08-01', to: '2026-08-31',
        });

        // Two rows, one unpaid day. Counting rows would deduct twice.
        expect(days).toHaveLength(1);
        expect(days[0].sources).toEqual(['REGULARIZATION', 'LEAVE_REQUEST']);
    });

    it('keeps separate days and separate employees apart', async () => {
        anomalies = [
            { id: 1, employeeId: EMP, date: d('2026-08-11'), status: 'REJECTED', sourceKind: 'LEAVE_REQUEST', type: 'ABSENT' },
            { id: 2, employeeId: EMP, date: d('2026-08-12'), status: 'REJECTED', sourceKind: 'LEAVE_REQUEST', type: 'ABSENT' },
            { id: 3, employeeId: OTHER, date: d('2026-08-11'), status: 'REJECTED', sourceKind: 'LEAVE_REQUEST', type: 'ABSENT' },
        ];

        const days = await svc.listDisapprovedLeaveDays({
            tenantId: TENANT, from: '2026-08-01', to: '2026-08-31',
        });

        expect(days).toHaveLength(3);
    });
});

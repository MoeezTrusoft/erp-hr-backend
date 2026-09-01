// HR-ATT-POLICY-01 — attendance anomaly approval routing.
//
// This is the unit that gates money: a REJECTED anomaly triggers the
// DISAPPROVED_LEAVE deduction, and an APPROVED one releases a day that
// requires_regularization is holding. The tests below concentrate on the ways
// that can go wrong silently rather than on happy-path coverage.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';

const REQUESTER = 100;
const MANAGER = 200;
const HR = 300;
const MANAGEMENT = 400;

// 1 = the requester's own manager (dynamic), 2 = HR, 3 = management.
const CHAIN = [
    { id: 1, level: 1, role: 'MANAGER', approverId: null, useEmployeeManager: true, skipIfUnresolved: true, rowStatus: 'ACTIVE' },
    { id: 2, level: 2, role: 'HR', approverId: HR, useEmployeeManager: false, skipIfUnresolved: true, rowStatus: 'ACTIVE' },
    { id: 3, level: 3, role: 'MANAGEMENT', approverId: MANAGEMENT, useEmployeeManager: false, skipIfUnresolved: true, rowStatus: 'ACTIVE' },
];

let employees;
let anomalies;
let approvalsWritten;

const prismaMock = {
    attendanceApprovalLevel: { findMany: jest.fn(async () => CHAIN) },
    employee: { findUnique: jest.fn(async ({ where }) => employees.get(where.id) ?? null) },
    attendanceAnomaly: {
        findUnique: jest.fn(async ({ where }) => anomalies.get(where.id) ?? null),
        findMany: jest.fn(async () => [...anomalies.values()].filter((a) => a.status === 'PENDING')),
        update: jest.fn(async ({ where, data }) => {
            const row = { ...anomalies.get(where.id), ...data };
            anomalies.set(where.id, row);
            return row;
        }),
    },
    attendanceAnomalyApproval: {
        create: jest.fn(async ({ data }) => { approvalsWritten.push(data); return { id: approvalsWritten.length, ...data }; }),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_client, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const routing = await import('../../src/services/attendanceAnomalyRouting.service.js');

beforeEach(() => {
    jest.clearAllMocks();
    approvalsWritten = [];
    employees = new Map([
        [REQUESTER, { id: REQUESTER, managerId: MANAGER }],
        [MANAGER, { id: MANAGER, managerId: null }],
        [HR, { id: HR, managerId: null }],
        [MANAGEMENT, { id: MANAGEMENT, managerId: null }],
    ]);
    anomalies = new Map([
        [1, { id: 1, employeeId: REQUESTER, status: 'PENDING', currentApprovalLevel: 1, tenantId: TENANT, createdAt: new Date('2026-08-01') }],
    ]);
    prismaMock.attendanceApprovalLevel.findMany.mockResolvedValue(CHAIN);
});

describe('HR-ATT-POLICY-01 chain resolution', () => {
    it('resolves level 1 from the requester own manager', async () => {
        const chain = await routing.resolveApprovalChain({ tenantId: TENANT, employeeId: REQUESTER });

        expect(chain[0]).toMatchObject({ level: 1, approverId: MANAGER, resolved: true });
        expect(chain[1]).toMatchObject({ level: 2, approverId: HR, resolved: true });
    });

    it('hops past the manager level when the employee has no manager', async () => {
        employees.set(REQUESTER, { id: REQUESTER, managerId: null });

        const res = await routing.routeAnomaly({ tenantId: TENANT, anomalyId: 1 });

        expect(res.routed).toBe(true);
        expect(res.level).toBe(2);            // straight to HR
        expect(res.approverId).toBe(HR);
    });

    it('never lets the requester approve their own request', async () => {
        // Someone who is their own manager, or who IS the configured HR approver.
        employees.set(REQUESTER, { id: REQUESTER, managerId: REQUESTER });

        const chain = await routing.resolveApprovalChain({ tenantId: TENANT, employeeId: REQUESTER });

        expect(chain[0]).toMatchObject({ resolved: false, reason: 'approver is the requester' });
    });

    it('skips an HR level whose approver is the requester', async () => {
        const res = await routing.routeAnomaly({ tenantId: TENANT, anomalyId: 1 });
        expect(res.level).toBe(1);

        anomalies.set(2, { id: 2, employeeId: HR, status: 'PENDING', currentApprovalLevel: 1, tenantId: TENANT, createdAt: new Date() });
        employees.set(HR, { id: HR, managerId: null });

        // HR raising their own anomaly: level 1 unresolved (no manager), level 2
        // is themselves, so it must land on management.
        const own = await routing.routeAnomaly({ tenantId: TENANT, anomalyId: 2 });
        expect(own.level).toBe(3);
        expect(own.approverId).toBe(MANAGEMENT);
    });
});

describe('HR-ATT-POLICY-01 unroutable requests', () => {
    it('does NOT auto-approve when no level resolves', async () => {
        prismaMock.attendanceApprovalLevel.findMany.mockResolvedValue([]);

        const res = await routing.routeAnomaly({ tenantId: TENANT, anomalyId: 1 });

        expect(res.routed).toBe(false);
        // Still PENDING: approving would release a held day, rejecting would
        // trigger a deduction. Neither may happen by accident.
        expect(anomalies.get(1).status).toBe('PENDING');
        expect(prismaMock.attendanceAnomaly.update).not.toHaveBeenCalled();
    });

    it('blocks on a non-skippable level rather than stepping over it', async () => {
        prismaMock.attendanceApprovalLevel.findMany.mockResolvedValue([
            { ...CHAIN[0], skipIfUnresolved: false },
            CHAIN[1],
        ]);
        employees.set(REQUESTER, { id: REQUESTER, managerId: null });

        const res = await routing.routeAnomaly({ tenantId: TENANT, anomalyId: 1 });

        expect(res.routed).toBe(false);       // must NOT fall through to HR
    });
});

describe('HR-ATT-POLICY-01 decisions', () => {
    it('advances through the chain on approval and only finalises at the end', async () => {
        const first = await routing.decideAnomaly({
            tenantId: TENANT, anomalyId: 1, approverId: MANAGER, decision: 'APPROVED',
        });
        expect(first.final).toBe(false);
        expect(first.nextLevel).toBe(2);
        expect(anomalies.get(1).status).toBe('PENDING');

        const second = await routing.decideAnomaly({
            tenantId: TENANT, anomalyId: 1, approverId: HR, decision: 'APPROVED',
        });
        expect(second.final).toBe(false);
        expect(second.nextLevel).toBe(3);

        const third = await routing.decideAnomaly({
            tenantId: TENANT, anomalyId: 1, approverId: MANAGEMENT, decision: 'APPROVED',
        });
        expect(third.final).toBe(true);
        expect(anomalies.get(1).status).toBe('APPROVED');
        expect(approvalsWritten).toHaveLength(3);
    });

    it('treats a rejection at any level as terminal', async () => {
        const res = await routing.decideAnomaly({
            tenantId: TENANT, anomalyId: 1, approverId: MANAGER, decision: 'REJECTED', comments: 'no',
        });

        expect(res.final).toBe(true);
        expect(anomalies.get(1).status).toBe('REJECTED');
        expect(anomalies.get(1).reviewerId).toBe(MANAGER);
    });

    it('refuses a decision from anyone but the current level approver', async () => {
        // HR is level 2; the anomaly is sitting at level 1.
        await expect(
            routing.decideAnomaly({ tenantId: TENANT, anomalyId: 1, approverId: HR, decision: 'APPROVED' }),
        ).rejects.toThrow('not the approver for this level');

        expect(approvalsWritten).toHaveLength(0);
    });

    it('refuses to re-decide a settled anomaly', async () => {
        await routing.decideAnomaly({ tenantId: TENANT, anomalyId: 1, approverId: MANAGER, decision: 'REJECTED' });

        await expect(
            routing.decideAnomaly({ tenantId: TENANT, anomalyId: 1, approverId: MANAGER, decision: 'APPROVED' }),
        ).rejects.toThrow('already REJECTED');
    });

    it('rejects a decision value that is neither APPROVED nor REJECTED', async () => {
        await expect(
            routing.decideAnomaly({ tenantId: TENANT, anomalyId: 1, approverId: MANAGER, decision: 'MAYBE' }),
        ).rejects.toThrow('must be APPROVED or REJECTED');
    });
});

describe('HR-ATT-POLICY-01 approver queue', () => {
    it('shows an anomaly only to the approver of its current level', async () => {
        const forManager = await routing.listPendingForApprover({ tenantId: TENANT, approverId: MANAGER });
        const forHr = await routing.listPendingForApprover({ tenantId: TENANT, approverId: HR });

        expect(forManager.map((a) => a.id)).toEqual([1]);
        expect(forHr).toHaveLength(0);        // not their turn yet
    });
});

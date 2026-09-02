// HR-OT-APPROVAL-01 — overtime through the payroll approval chain.
//
// Overtime is money paid out, so the tests concentrate on the ways it could be
// paid wrongly: hours reaching payroll before final approval, the same day
// claimed twice, an unroutable request approving itself, or somebody approving
// their own overtime.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const REQUESTER = 100, MANAGER = 200, FINANCE = 300;

let matrix, requests, approvals, assignments, punches;

const prismaMock = {
    payrollApprovalMatrix: { findMany: jest.fn(async () => matrix) },
    overtimeRequest: {
        findFirst: jest.fn(async ({ where }) => requests.find((r) =>
            r.employeeId === where.employeeId && (!where.status || where.status.in.includes(r.status))) ?? null),
        findUnique: jest.fn(async ({ where }) => requests.find((r) => r.id === where.id) ?? null),
        findMany: jest.fn(async () => requests.filter((r) => r.status === 'PENDING')),
        create: jest.fn(async ({ data }) => { const r = { id: requests.length + 1, ...data }; requests.push(r); return r; }),
        update: jest.fn(async ({ where, data }) => { const r = requests.find((x) => x.id === where.id); Object.assign(r, data); return r; }),
    },
    overtimeRequestApproval: { create: jest.fn(async ({ data }) => { approvals.push(data); return { id: approvals.length, ...data }; }) },
    shiftAssignment: {
        findFirst: jest.fn(async () => assignments[0] ?? null),
        update: jest.fn(async ({ data }) => { Object.assign(assignments[0], data); return assignments[0]; }),
        create: jest.fn(async ({ data }) => { assignments.push(data); return data; }),
    },
    attendanceDevicePunch: { findMany: jest.fn(async () => punches) },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_c, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const ot = await import('../../src/services/overtimeApproval.service.js');

beforeEach(() => {
    jest.clearAllMocks();
    matrix = [
        { level: 1, role: 'MANAGER', approverId: MANAGER, status: 'ACTIVE' },
        { level: 2, role: 'FINANCE', approverId: FINANCE, status: 'ACTIVE' },
    ];
    requests = []; approvals = []; assignments = []; punches = [];
});

const raise = () => ot.createOvertimeRequest({
    tenantId: TENANT, employeeId: REQUESTER, date: '2026-08-14', hours: 3, reason: 'release night',
});

describe('HR-OT-APPROVAL-01 raising', () => {
    it('routes to the first payroll approval level', async () => {
        const r = await raise();
        expect(r.routed).toBe(true);
        expect(r.level).toBe(1);
        expect(r.request.status).toBe('PENDING');
    });

    it('refuses a second live claim for the same day', async () => {
        await raise();
        await expect(raise()).rejects.toThrow('already PENDING');
    });

    it('rejects impossible hours rather than trusting the input', async () => {
        await expect(ot.createOvertimeRequest({
            tenantId: TENANT, employeeId: REQUESTER, date: '2026-08-14', hours: 20, reason: 'x',
        })).rejects.toThrow('16 or fewer');
    });

    it('does not auto-approve when no approver resolves', async () => {
        matrix = [];
        const r = await raise();
        expect(r.routed).toBe(false);
        expect(r.request.status).toBe('PENDING');   // never approved by default
    });

    it('never lets someone approve their own overtime', async () => {
        matrix = [{ level: 1, role: 'MANAGER', approverId: REQUESTER, status: 'ACTIVE' }];
        const chain = await ot.resolveOvertimeChain({ tenantId: TENANT, employeeId: REQUESTER });
        expect(chain[0]).toMatchObject({ resolved: false, reason: 'approver is the requester' });
    });
});

describe('HR-OT-APPROVAL-01 payroll only sees approved hours', () => {
    it('writes NOTHING to payroll at an intermediate approval', async () => {
        const { request } = await raise();
        const first = await ot.decideOvertimeRequest({
            tenantId: TENANT, requestId: request.id, approverId: MANAGER, decision: 'APPROVED',
        });

        expect(first.final).toBe(false);
        expect(first.payrollHours).toBeNull();
        expect(assignments).toHaveLength(0);        // payroll untouched
    });

    it('writes the hours only on the FINAL approval', async () => {
        const { request } = await raise();
        await ot.decideOvertimeRequest({ tenantId: TENANT, requestId: request.id, approverId: MANAGER, decision: 'APPROVED' });
        const last = await ot.decideOvertimeRequest({ tenantId: TENANT, requestId: request.id, approverId: FINANCE, decision: 'APPROVED' });

        expect(last.final).toBe(true);
        expect(last.payrollHours).toBe(3);
        expect(assignments[0].overtimeHours).toBe(3);
    });

    it('writes nothing when rejected at any level', async () => {
        const { request } = await raise();
        const res = await ot.decideOvertimeRequest({
            tenantId: TENANT, requestId: request.id, approverId: MANAGER, decision: 'REJECTED',
        });

        expect(res.final).toBe(true);
        expect(res.payrollHours).toBeNull();
        expect(assignments).toHaveLength(0);
    });

    it('refuses a decision from anyone but the current approver', async () => {
        const { request } = await raise();
        await expect(ot.decideOvertimeRequest({
            tenantId: TENANT, requestId: request.id, approverId: FINANCE, decision: 'APPROVED',
        })).rejects.toThrow('not the approver for this level');
    });
});

describe('HR-OT-APPROVAL-01 detection from device punches', () => {
    const p = (iso, status) => ({ employeeId: REQUESTER, punchedAt: new Date(iso), status });

    it('pairs overtime-in with overtime-out', async () => {
        // ZKTeco 4 = Overtime-In, 5 = Overtime-Out.
        punches = [p('2026-08-14T18:00:00Z', 4), p('2026-08-14T21:30:00Z', 5)];

        const s = await ot.detectOvertimeFromPunches({ tenantId: TENANT, from: '2026-08-01', to: '2026-08-31' });

        expect(s.details).toEqual([{ employeeId: REQUESTER, date: '2026-08-14', hours: 3.5 }]);
        expect(s.dryRun).toBe(true);
        expect(requests).toHaveLength(0);       // dry run writes nothing
    });

    it('reports a lone overtime punch rather than inventing a duration', async () => {
        punches = [p('2026-08-14T18:00:00Z', 4)];

        const s = await ot.detectOvertimeFromPunches({ tenantId: TENANT, from: '2026-08-01', to: '2026-08-31' });

        expect(s.created).toBe(0);
        expect(s.unpaired).toBe(1);
    });

    it('attributes overtime past midnight to the day it started', async () => {
        punches = [p('2026-08-14T23:00:00Z', 4), p('2026-08-15T02:00:00Z', 5)];

        const s = await ot.detectOvertimeFromPunches({ tenantId: TENANT, from: '2026-08-01', to: '2026-08-31' });

        expect(s.details[0]).toMatchObject({ date: '2026-08-14', hours: 3 });
    });
});

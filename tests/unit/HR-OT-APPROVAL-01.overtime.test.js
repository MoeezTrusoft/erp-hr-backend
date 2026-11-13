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
    $executeRaw: jest.fn(),
    payrollRun: { findFirst: jest.fn(async () => null) },
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
const {applyDecision} = await import('../../src/services/approval/adapters.js');
const finalize=(request,approved)=>applyDecision(prismaMock,{tenantId:TENANT,now:new Date(),who:{id:FINANCE,employee_code:'MGMT-300'}},{kind:'OVERTIME'},{row:request},approved,'Final Management decision');

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
    it('awaits employee submission to the shared review workflow', async () => {
        const r = await raise();
        expect(r.routed).toBe(false);
        expect(r.level).toBeNull();expect(r.stage).toBe('INITIATOR');
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
    it('leaves pending hours out of payroll and blocks the legacy direct decision', async()=>{const {request}=await raise();await expect(ot.decideOvertimeRequest({tenantId:TENANT,requestId:request.id,approverId:MANAGER,decision:'APPROVED'})).rejects.toMatchObject({status:401});expect(request.status).toBe('PENDING');expect(assignments).toHaveLength(0);});
    it('writes hours at final Management approval to the existing roster',async()=>{const {request}=await raise();assignments.push({id:1,overtimeHours:0});await finalize(request,true);expect(request.status).toBe('APPROVED');expect(assignments[0].overtimeHours).toBe(3);});
    it('Management rejection leaves payroll untouched',async()=>{const {request}=await raise();await finalize(request,false);expect(request.status).toBe('REJECTED');expect(assignments).toHaveLength(0);});
    it('refuses final approval without a roster',async()=>{const {request}=await raise();await expect(finalize(request,true)).rejects.toThrow('Configure the roster');expect(request.status).toBe('PENDING');expect(assignments).toHaveLength(0);});
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

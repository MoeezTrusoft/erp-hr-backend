// C3/C4/C5 — leave write-back regression (operator plan 2026-09-18, Workstream E1).
//
// The old createLeaveAttendanceRecords had three production-grade defects:
//   • stamped ABSENT on every leave day (approved leave fed the absence
//     deduction bridge and the Absentees KPI);
//   • hardcoded Sat/Sun weekends instead of the employee's roster;
//   • upsert-overwrote existing rows, erasing real biometric punches.
// And nothing wrote the legacy Leave table that workingDay.service reads, so
// approved leave never became ON_LEAVE precedence in attendance derivation.
//
// These tests pin the corrected behavior: ON_LEAVE + day_credit 1 only on
// rostered working days, punch rows never overwritten, a Leave mirror row
// upserted on final approval, and a clear 400 when a request without a leave
// type reaches the approval path.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const DAY = 24 * 60 * 60 * 1000;
const midnight = (iso) => { const d = new Date(`${iso}T00:00:00.000Z`); return d; };

// ── Mocks ────────────────────────────────────────────────────────────────────
const leavePolicyRow = { id: 73, name: 'Annual Leave', leaveTypeCode: 'ANNUAL' };

let workingDaysMap; // resolveWorkingDays result (Map keyed ISO date)
let attendanceRows; // keyed employeeId_date → row
let createdAttendance;
let updatedAttendance;
let legacyLeaveRows; // prisma.leave.findFirst result
let createdLegacyLeave;
let updatedLegacyLeave;

const prismaMock = {
    leavePolicy: { findUnique: jest.fn(async () => leavePolicyRow) },
    // The approval path re-fetches the request; the C5 suite swaps this stub.
    // `update` runs inside the tenant transaction (status flip).
    leaveRequest: {
        findUnique: jest.fn(async () => null),
        update: jest.fn(async ({ data }) => ({ id: 1, ...data })),
    },
    // Approval-row dedup + the final-approval counter + the recorded decision.
    leaveRequestApproval: {
        findFirst: jest.fn(async () => null),
        count: jest.fn(async () => 1),
        create: jest.fn(async ({ data }) => data),
    },
    // C5 — balance exists → decrement path; assert via update.
    leaveBalance: {
        findUnique: jest.fn(async () => ({ employeeId: 481, leavePolicyId: 73, balance: 14 })),
        update: jest.fn(async ({ data }) => data),
        create: jest.fn(async ({ data }) => data),
    },
    attendance: {
        findUnique: jest.fn(async ({ where }) =>
            attendanceRows.get(where.employeeId_date.date.toISOString().slice(0, 10)) || null),
        update: jest.fn(async ({ where, data }) => {
            updatedAttendance.push({ id: where.id, data });
            return { id: where.id };
        }),
        create: jest.fn(async ({ data }) => {
            createdAttendance.push(data);
            return { id: createdAttendance.length };
        }),
    },
    leave: {
        findFirst: jest.fn(async () => legacyLeaveRows),
        update: jest.fn(async ({ where, data }) => {
            updatedLegacyLeave.push({ id: where.id, data });
            return { id: where.id };
        }),
        create: jest.fn(async ({ data }) => {
            createdLegacyLeave.push(data);
            return { id: createdLegacyLeave.length + 400 };
        }),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
// tenantData/withTenant pass data through untouched in the mock lane.
jest.unstable_mockModule('../../src/lib/tenancy.js', () => ({
    tenantData: (_t, data) => data,
    withTenant: (_t, where) => where,
}));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: async (prisma, fn) => fn(prisma),
}));
jest.unstable_mockModule('../../src/utils/logs.js', () => ({ logAction: jest.fn() }));
jest.unstable_mockModule('../../src/services/hrDomainEvent.service.js', () => ({
    enqueueHrDomainEvent: jest.fn(),
}));
jest.unstable_mockModule('../../src/services/hrEvents.js', () => ({
    leaveApprovedEvent: jest.fn(() => null),
    leaveRejectedEvent: jest.fn(() => null),
}));
// workingDay derivation is stubbed with a canned Map — its internals are
// covered by HR-ATT-POLICY-01.working-day.test.js.
jest.unstable_mockModule('../../src/services/workingDay.service.js', () => ({
    resolveWorkingDays: jest.fn(async () => workingDaysMap),
}));

const svc = await import('../../src/services/leave.service.js');

const wd = (iso, working) => [iso, { date: midnight(iso), working }];

const leaveRequest = (over = {}) => ({
    employeeId: 481,
    startDate: midnight('2026-09-21'),
    endDate: midnight('2026-09-23'),
    leavePolicyId: 73,
    totalDays: 3,
    tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    attendanceRows = new Map();
    createdAttendance = [];
    updatedAttendance = [];
    legacyLeaveRows = null;
    createdLegacyLeave = [];
    updatedLegacyLeave = [];
    // Mon 21st, Tue 22nd working; Wed 23rd rostered off (offDays include 3=Wed).
    workingDaysMap = new Map([
        wd('2026-09-21', true),
        wd('2026-09-22', true),
        wd('2026-09-23', false),
    ]);
});

describe('C3 — createLeaveAttendanceRecords (via approveLeaveRequest final path)', () => {
    const finalApprove = () =>
        svc.approveLeaveRequest(1, {
            approverId: 558, approverRole: 'HR', comments: null, createdById: 558,
            ctx: {},
        });

    beforeEach(() => {
        // A FINAL-approval fetch: PENDING request with a policy and no workflow
        // steps → newStatus = APPROVED on the first approval.
        prismaMock.leaveRequest.findUnique.mockImplementation(async () => ({
            id: 1,
            employeeId: 481,
            status: 'PENDING',
            leavePolicyId: 73,
            tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
            totalDays: 3,
            startDate: midnight('2026-09-21'),
            endDate: midnight('2026-09-23'),
            approvals: [],
            leavePolicy: { id: 73, name: 'Annual Leave', leaveTypeCode: 'ANNUAL', approvalWorkflow: null },
        }));
    });

    it('marks rostered working days ON_LEAVE with day_credit 1 — never ABSENT', async () => {
        await finalApprove();

        expect(createdAttendance).toHaveLength(2); // 21st + 22nd; 23rd is rostered off
        for (const row of createdAttendance) {
            expect(row.status).toBe('ON_LEAVE');
            expect(row.day_credit).toBe(1);
            expect(row.remarks).toBe('On Annual Leave');
        }
        expect(createdAttendance.some((r) => r.status === 'ABSENT')).toBe(false);
    });

    it('skips days that already carry a real biometric punch (integrity)', async () => {
        attendanceRows.set('2026-09-22', {
            id: 9, check_in: new Date(), check_out: new Date(), status: 'PRESENT',
        });

        await finalApprove();

        expect(createdAttendance).toHaveLength(1); // only the 21st created
        expect(createdAttendance[0].status).toBe('ON_LEAVE');
        expect(updatedAttendance).toHaveLength(0); // punch row untouched
    });

    it('downgrades an existing empty row to ON_LEAVE instead of duplicating', async () => {
        attendanceRows.set('2026-09-21', { id: 7, check_in: null, check_out: null, status: 'ABSENT' });

        await finalApprove();

        expect(updatedAttendance).toHaveLength(1);
        expect(updatedAttendance[0]).toMatchObject({
            id: 7,
            data: expect.objectContaining({ status: 'ON_LEAVE', day_credit: 1 }),
        });
        expect(createdAttendance).toHaveLength(1); // only the 22nd
    });
});

describe('C4 — legacy Leave mirror', () => {
    beforeEach(() => {
        prismaMock.leaveRequest.findUnique.mockImplementation(async () => ({
            id: 1,
            employeeId: 481,
            status: 'PENDING',
            leavePolicyId: 73,
            tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
            totalDays: 3,
            startDate: midnight('2026-09-21'),
            endDate: midnight('2026-09-23'),
            approvals: [],
            leavePolicy: { id: 73, name: 'Annual Leave', leaveTypeCode: 'ANNUAL', approvalWorkflow: null },
        }));
    });

    it('creates the Leave row day-derivation reads on final approval', async () => {
        await svc.approveLeaveRequest(1, {
            approverId: 558, approverRole: 'HR', comments: null, createdById: 558,
            ctx: {},
        });

        expect(createdLegacyLeave).toHaveLength(1);
        expect(createdLegacyLeave[0]).toMatchObject({
            employeeId: 481,
            type: 'ANNUAL',
            status: 'APPROVED',
            total_days: 3,
        });
    });

    it('reuses (updates) an existing mirror row instead of duplicating', async () => {
        legacyLeaveRows = { id: 321, employeeId: 481, status: 'PENDING' };

        await svc.approveLeaveRequest(1, {
            approverId: 558, approverRole: 'HR', comments: null, createdById: 558,
            ctx: {},
        });

        expect(createdLegacyLeave).toHaveLength(0);
        expect(updatedLegacyLeave).toHaveLength(1);
        expect(updatedLegacyLeave[0]).toMatchObject({
            id: 321,
            data: expect.objectContaining({ type: 'ANNUAL', status: 'APPROVED' }),
        });
    });
});

describe('C5 — approval guards', () => {
    it('refuses approval of a null-policy request with a clear 400', async () => {
        prismaMock.leaveRequest.findUnique.mockImplementationOnce(async () => ({
            id: 2, employeeId: 481, status: 'PENDING', leavePolicyId: null,
            approvals: [], leavePolicy: null,
        }));

        await expect(
            svc.approveLeaveRequest(2, {
                approverId: 558, approverRole: 'HR', comments: null, createdById: 558,
            })
        ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Leave type must be assigned') });
    });
});

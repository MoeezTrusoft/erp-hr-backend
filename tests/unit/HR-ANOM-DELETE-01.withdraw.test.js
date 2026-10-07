// TS-ANOM-DELETE-01 — withdrawing a PENDING anomaly request.
//
// Operator ruling (2026-10-07): only the EMPLOYEE the request is about may
// delete it, or HR when HR raised it on their behalf (raisedById = filler).
// Decided (APPROVED/REJECTED) requests are part of the payroll record and
// cannot be withdrawn. Deletion also removes the request's approval-chain
// rows so a re-raise for the same employee-day is not blocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 'tenant-A';

let existingAnomaly;
let deletedAnomalyIds;
let deletedApprovalAnomalyIds;

const prismaMock = {
    attendanceAnomaly: {
        findFirst: jest.fn(async () => existingAnomaly),
        delete: jest.fn(async ({ where }) => {
            deletedAnomalyIds.push(where.id);
            return { id: where.id };
        }),
    },
    attendanceAnomalyApproval: {
        deleteMany: jest.fn(async ({ where }) => {
            deletedApprovalAnomalyIds.push(where.anomalyId);
            return { count: 1 };
        }),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({tenantTransaction:async(_client,fn)=>fn(prismaMock)}));

const svc = await import('../../src/services/attendanceAnomaly.service.js');

// scopedWhere folds the verified tenant into the where clause; here we only
// need it to be identity so the mocks receive plain ids.
jest.unstable_mockModule('../../src/lib/tenancy.js', () => ({
    scopedWhere: jest.fn((_t, w) => w),
}));

const EMPLOYEE = 90;   // the request's subject
const HR_FILLER = 214; // HR raised it on the employee's behalf

beforeEach(() => {
    jest.clearAllMocks();
    deletedAnomalyIds = [];
    deletedApprovalAnomalyIds = [];
    existingAnomaly = {
        id: 55,
        status: 'PENDING',
        type: 'MISSING_CHECKOUT',
        employeeId: EMPLOYEE,
        raisedById: HR_FILLER,
        raisedByName: 'HR Ops',
        sourceRef: 'regularization:90:2026-09-14',
    };
});

describe('TS-ANOM-DELETE-01 — who may delete', () => {
    it('lets the subject employee delete their own request', async () => {
        const out = await svc.deleteAnomaly({ tenantId: TENANT, id: 55, requesterEmployeeId: EMPLOYEE });
        expect(deletedAnomalyIds).toEqual([55]);
        expect(out.status).toBe('DELETED');
        expect(out.deletedBy).toBe(EMPLOYEE);
    });

    it('lets the HR user who raised it on behalf delete it', async () => {
        const out = await svc.deleteAnomaly({ tenantId: TENANT, id: 55, requesterEmployeeId: HR_FILLER });
        expect(deletedAnomalyIds).toEqual([55]);
        expect(out.deletedBy).toBe(HR_FILLER);
    });

    it('refuses everyone else with 403', async () => {
        await expect(
            svc.deleteAnomaly({ tenantId: TENANT, id: 55, requesterEmployeeId: 999 })
        ).rejects.toMatchObject({ status: 403 });
        expect(deletedAnomalyIds).toHaveLength(0);
    });

    it('refuses a coworker filing for someone with no on-behalf record', async () => {
        existingAnomaly.raisedById = null; // self-raised by the employee
        await expect(
            svc.deleteAnomaly({ tenantId: TENANT, id: 55, requesterEmployeeId: 999 })
        ).rejects.toMatchObject({ status: 403 });
    });
});

describe('TS-ANOM-DELETE-01 — what may be deleted', () => {
    it('refuses decided requests (payroll record, immutable)', async () => {
        existingAnomaly.status = 'APPROVED';
        await expect(
            svc.deleteAnomaly({ tenantId: TENANT, id: 55, requesterEmployeeId: EMPLOYEE })
        ).rejects.toMatchObject({ status: 400 });
        expect(deletedAnomalyIds).toHaveLength(0);
    });

    it('404s a foreign-tenant / missing id', async () => {
        existingAnomaly = null;
        await expect(
            svc.deleteAnomaly({ tenantId: TENANT, id: 55, requesterEmployeeId: EMPLOYEE })
        ).rejects.toMatchObject({ status: 404 });
    });

    it('removes the approval-chain rows with the request', async () => {
        await svc.deleteAnomaly({ tenantId: TENANT, id: 55, requesterEmployeeId: HR_FILLER });
        expect(deletedApprovalAnomalyIds).toEqual([55]);
        expect(deletedAnomalyIds).toEqual([55]);
    });

    it('requires an id', async () => {
        await expect(
            svc.deleteAnomaly({ tenantId: TENANT, id: undefined, requesterEmployeeId: EMPLOYEE })
        ).rejects.toMatchObject({ status: 400 });
    });
});

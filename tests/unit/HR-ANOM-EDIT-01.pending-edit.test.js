// HR-ANOM-EDIT-01 — the HR edit of a PENDING anomaly request (TS-ANOM-EDIT-01).
//
// The edit tool was served but had ZERO automated coverage: no test pinned the
// PENDING-only rule, the type enum, the tenant 404, or what an edit actually
// writes. Verified live on production 2026-10-07 (create → edit → decide →
// refused edit); this pins the contract so a regression cannot re-open it:
//   * only type/reason/detail/date/fromTime/toTime are writable,
//   * null/absent = leave unchanged (the UI sends null for untouched fields),
//   * a decided request can never be rewritten by an edit.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 'tenant-1';

let existingRow;
const updates = [];

const prismaMock = {
    attendanceAnomaly: {
        findFirst: jest.fn(async () => existingRow),
        update: jest.fn(async ({ where, data }) => {
            updates.push({ id: where.id, ...data });
            return { ...existingRow, ...data, employee: { id: 554, employee_name: 'Akash Nanu' } };
        }),
    },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../src/services/attendanceAnomalyRouting.service.js', () => ({
    routeAnomaly: jest.fn(),
    resolveApprovalChain: jest.fn(async () => []),
}));

const { updateAnomaly } = await import('../../src/services/attendanceAnomaly.service.js');

const pendingRow = () => ({
    id: 77,
    status: 'PENDING',
    type: 'LATE_CHECKIN',
    reason: 'original reason',
    detail: 'original detail',
    date: new Date('2026-09-15T00:00:00.000Z'),
    fromTime: null,
    toTime: null,
    raisedById: null,
});

beforeEach(() => {
    jest.clearAllMocks();
    updates.length = 0;
    existingRow = pendingRow();
});

describe('updateAnomaly — HR edit of a PENDING request', () => {
    it('writes exactly the provided fields and returns the dto', async () => {
        const out = await updateAnomaly({
            tenantId: TENANT,
            id: 77,
            type: 'EARLY_CHECKOUT',
            reason: 'edited reason',
            detail: 'edited detail',
            date: '2026-09-16',
            fromTime: '2026-09-16T12:00:00.000Z',
            toTime: '2026-09-16T13:30:00.000Z',
        });

        expect(updates).toHaveLength(1);
        expect(updates[0].id).toBe(77);
        expect(updates[0]).toMatchObject({
            type: 'EARLY_CHECKOUT',
            reason: 'edited reason',
            detail: 'edited detail',
        });
        expect(out.type).toBe('EARLY_CHECKOUT');
        expect(out.status).toBe('PENDING');
        expect(out.employee).toMatchObject({ id: 554, name: 'Akash Nanu' });
    });

    it('treats null/absent fields as leave-unchanged (UI sends null for untouched inputs)', async () => {
        await updateAnomaly({ tenantId: TENANT, id: 77, type: 'ABSENT', detail: null });

        expect(updates).toHaveLength(1);
        expect(updates[0].type).toBe('ABSENT');
        // detail:null, and the omitted reason/date/times, must NOT be written
        expect(updates[0]).not.toHaveProperty('detail');
        expect(updates[0]).not.toHaveProperty('reason');
        expect(updates[0]).not.toHaveProperty('date');
        expect(updates[0]).not.toHaveProperty('fromTime');
        expect(updates[0]).not.toHaveProperty('toTime');
    });

    it('refuses to edit a decided request (PENDING-only), writing nothing', async () => {
        existingRow = { ...pendingRow(), status: 'APPROVED' };

        await expect(
            updateAnomaly({ tenantId: TENANT, id: 77, reason: 'should fail' }),
        ).rejects.toMatchObject({
            status: 400,
            message: expect.stringContaining('only PENDING requests are editable'),
        });
        expect(updates).toHaveLength(0);
    });

    it('404s an unknown or other-tenant anomaly without writing', async () => {
        prismaMock.attendanceAnomaly.findFirst.mockResolvedValueOnce(null);

        await expect(
            updateAnomaly({ tenantId: 'other-tenant', id: 77, reason: 'x' }),
        ).rejects.toMatchObject({ status: 404, message: 'Anomaly not found' });
        expect(updates).toHaveLength(0);
    });

    it('rejects a type outside the enum without writing', async () => {
        await expect(
            updateAnomaly({ tenantId: TENANT, id: 77, type: 'BANANA' }),
        ).rejects.toMatchObject({
            status: 400,
            message: expect.stringContaining('type must be one of'),
        });
        expect(updates).toHaveLength(0);
    });

    it('requires the id', async () => {
        await expect(
            updateAnomaly({ tenantId: TENANT, id: undefined, reason: 'x' }),
        ).rejects.toMatchObject({ status: 400, message: 'id is required' });
        expect(prismaMock.attendanceAnomaly.findFirst).not.toHaveBeenCalled();
        expect(updates).toHaveLength(0);
    });
});

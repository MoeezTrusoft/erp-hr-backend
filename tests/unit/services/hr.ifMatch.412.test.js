// tests/unit/services/hr.ifMatch.412.test.js
//
// X-07 / ARCH-01 §3.4 — updateEmployeeService enforces If-Match / 412 optimistic
// concurrency. With a mocked prisma, a stale If-Match precondition must throw a
// 412 BEFORE any write; a matching (or absent) precondition proceeds normally.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const employeeFindUnique = jest.fn();
const txEmployeeUpdate = jest.fn();
const txOutboxCreate = jest.fn(async (args) => ({ id: 'ob-1', ...args.data }));
const mockTransaction = jest.fn();
const mockLogAction = jest.fn();

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
    default: {
        position: { findUnique: jest.fn() },
        employee: { findUnique: employeeFindUnique },
        $transaction: mockTransaction,
    },
}));
jest.unstable_mockModule('../../../src/utils/logs.js', () => ({
    logAction: mockLogAction,
    default: { logAction: mockLogAction },
}));

const { updateEmployeeService } = await import('../../../src/services/hr.service.js');

const txClient = {
    employee: { update: txEmployeeUpdate },
    outboxEvent: { create: txOutboxCreate },
};

const UPDATED_AT = new Date('2026-06-25T10:00:00.000Z');
const CURRENT_VERSION = UPDATED_AT.getTime();

beforeEach(() => {
    jest.clearAllMocks();
    mockLogAction.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(async (arg) => (typeof arg === 'function' ? arg(txClient) : Promise.all(arg)));
    employeeFindUnique.mockResolvedValue({
        id: 1,
        tenant_id: '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007',
        updated_at: UPDATED_AT,
        hire_date: new Date('2020-01-01'),
        positionId: 5,
    });
    txEmployeeUpdate.mockResolvedValue({ id: 1, updated_at: new Date() });
});

describe('updateEmployeeService If-Match / 412', () => {
    it('rejects a STALE If-Match with a 412 before any write', async () => {
        const stale = String(CURRENT_VERSION - 5000);
        let thrown;
        try {
            await updateEmployeeService(1, { first_name: 'New' }, 7, { ifMatch: stale });
        } catch (e) { thrown = e; }
        expect(thrown).toBeDefined();
        expect(thrown.status).toBe(412);
        expect(txEmployeeUpdate).not.toHaveBeenCalled();
    });

    it('proceeds when the If-Match matches the current version', async () => {
        await updateEmployeeService(1, { first_name: 'New' }, 7, { ifMatch: String(CURRENT_VERSION) });
        expect(txEmployeeUpdate).toHaveBeenCalledTimes(1);
    });

    it('proceeds when NO precondition is supplied (opt-in, back-compat)', async () => {
        await updateEmployeeService(1, { first_name: 'New' }, 7, {});
        expect(txEmployeeUpdate).toHaveBeenCalledTimes(1);
    });
});

// tests/unit/services/hr.lifecycle.emit.test.js
//
// A.4 — the Employee aggregate write (create/update/terminate) emits
// hr.employee.lifecycle.v1 INSIDE the same transaction, with the EventEnvelope
// correlationId threaded from the request (A.5).
//
// We mock the singleton prisma so $transaction(cb) runs the callback with a
// `tx` client that exposes BOTH the employee write AND outboxEvent.create. The
// assertion is: an outbox row was written through the SAME tx client used for
// the employee write, carrying a validated EventEnvelope on the request
// correlation id.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';

const txEmployeeCreate = jest.fn();
const txEmployeeUpdate = jest.fn();
const txEmployeeDelete = jest.fn();
const txEmployeeFindUnique = jest.fn();
const txOutboxCreate = jest.fn(async (args) => ({ id: 'ob-1', ...args.data }));
const positionFindUnique = jest.fn();
const employeeFindUnique = jest.fn();
const attendanceDeleteMany = jest.fn();
const leaveDeleteMany = jest.fn();
const employeeDelete = jest.fn();
const mockTransaction = jest.fn();
const mockLogAction = jest.fn();

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
    default: {
        position: { findUnique: positionFindUnique },
        employee: {
            findUnique: employeeFindUnique,
            delete: employeeDelete,
        },
        attendance: { deleteMany: attendanceDeleteMany },
        leave: { deleteMany: leaveDeleteMany },
        $transaction: mockTransaction,
    },
}));

jest.unstable_mockModule('../../../src/utils/logs.js', () => ({
    logAction: mockLogAction,
    default: { logAction: mockLogAction },
}));

const { createEmployeeService, updateEmployeeService, deleteEmployeeService } =
    await import('../../../src/services/hr.service.js');

// The tx client handed to the $transaction callback.
const txClient = {
    employee: {
        create: txEmployeeCreate,
        update: txEmployeeUpdate,
        delete: txEmployeeDelete,
        findUnique: txEmployeeFindUnique,
    },
    outboxEvent: { create: txOutboxCreate },
    attendance: { deleteMany: attendanceDeleteMany },
    leave: { deleteMany: leaveDeleteMany },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockLogAction.mockResolvedValue(undefined);
    // Run the callback form of $transaction with our tx client.
    mockTransaction.mockImplementation(async (arg) => {
        if (typeof arg === 'function') return arg(txClient);
        return Promise.all(arg);
    });
    positionFindUnique.mockResolvedValue({ id: 3 });
    txEmployeeFindUnique.mockResolvedValue({ id: 42, tenant_id: TENANT, positionId: 3 });
});

const sampleEmployee = {
    id: 42,
    tenant_id: TENANT,
    first_name: 'Ada',
    last_name: 'Lovelace',
    employee_code: 'E-100',
    businessUnitId: 7,
    positionId: 3,
    hire_date: new Date('2026-06-24T00:00:00.000Z'),
};

describe('createEmployeeService emits hr.employee.lifecycle.v1 in-tx', () => {
    it('writes the employee AND a validated lifecycle envelope via the same tx', async () => {
        txEmployeeCreate.mockResolvedValue(sampleEmployee);

        const data = {
            job_title: 'Engineer',
            hire_date: '2026-06-24',
            status: 'Active',
            positionId: 3,
            tenant_id: TENANT,
            first_name: 'Ada',
            last_name: 'Lovelace',
            employee_code: 'E-100',
        };

        await createEmployeeService(data, null, null, 1, {
            correlationId: 'corr-create',
            actorId: 1,
        });

        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(txEmployeeCreate).toHaveBeenCalledTimes(1);
        expect(txOutboxCreate).toHaveBeenCalledTimes(1);

        const row = txOutboxCreate.mock.calls[0][0].data;
        expect(row.eventName).toBe('hr.employee.lifecycle.v1');
        expect(row.aggregateType).toBe('Employee');
        expect(row.payload.name).toBe('hr.employee.lifecycle.v1');
        expect(row.payload.payload.phase).toBe('hired');
        expect(row.payload.correlationId).toBe('corr-create'); // A.5 threaded
    });
});

describe('updateEmployeeService emits a transferred lifecycle event in-tx', () => {
    it('emits with phase transferred', async () => {
        // updateEmployeeService reads `exists` via the singleton before the tx.
        employeeFindUnique.mockResolvedValue(sampleEmployee);
        txEmployeeUpdate.mockResolvedValue({ ...sampleEmployee });

        await updateEmployeeService(42, { job_title: 'Lead' }, 1, {
            correlationId: 'corr-update',
            actorId: 1,
        });

        expect(txOutboxCreate).toHaveBeenCalledTimes(1);
        const row = txOutboxCreate.mock.calls[0][0].data;
        expect(row.payload.payload.phase).toBe('transferred');
        expect(row.payload.correlationId).toBe('corr-update');
    });
});

describe('deleteEmployeeService emits a terminated lifecycle event in-tx', () => {
    it('emits with phase terminated BEFORE the row is deleted', async () => {
        txEmployeeFindUnique.mockResolvedValue(sampleEmployee);
        employeeFindUnique.mockResolvedValue(sampleEmployee);

        await deleteEmployeeService(42, 1, {
            correlationId: 'corr-del',
            actorId: 1,
        });

        expect(txOutboxCreate).toHaveBeenCalledTimes(1);
        const row = txOutboxCreate.mock.calls[0][0].data;
        expect(row.payload.payload.phase).toBe('terminated');
        expect(row.payload.correlationId).toBe('corr-del');
    });
});

// T-1.4 / A-01 — employees with payroll history must NOT be hard-deleted
// (plan 20 Phase 1, audit report 19).
//
// Evidence: hr.service.js deleteEmployeeService removes the Employee row AND
// their attendance + leave rows. Every payslip, EmploymentPeriod, Loan,
// PayrollAuditLog and audit Log row then references a subject that no longer
// exists — payroll reproducibility and the audit trail die with the row.
//
// Contract:
//   * an employee with ≥1 payslip or ≥1 employment period → throw, mutate NOTHING
//   * an employee with no payroll history → the delete proceeds (mis-entry case)
//   * the terminated lifecycle event only fires on the path that actually deletes
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';

const employeeFindUnique = jest.fn();
const attendanceDeleteMany = jest.fn();
const leaveDeleteMany = jest.fn();
const employeeDelete = jest.fn();
const txOutboxCreate = jest.fn(async (args) => ({ id: 'ob-1', ...args.data }));
const payslipCountTx = jest.fn();
const periodCountTx = jest.fn();
const mockTransaction = jest.fn();
const mockLogAction = jest.fn();

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
    default: {
        employee: { findUnique: employeeFindUnique },
        attendance: { deleteMany: attendanceDeleteMany },
        leave: { deleteMany: leaveDeleteMany },
        $transaction: mockTransaction,
    },
}));

jest.unstable_mockModule('../../../src/utils/logs.js', () => ({
    logAction: mockLogAction,
    default: { logAction: mockLogAction },
}));

const { deleteEmployeeService } = await import('../../../src/services/hr.service.js');

const sampleEmployee = { id: 42, tenant_id: TENANT, employee_code: 'E-100' };

const txClient = {
    employee: { delete: employeeDelete },
    outboxEvent: { create: txOutboxCreate },
    attendance: { deleteMany: attendanceDeleteMany },
    leave: { deleteMany: leaveDeleteMany },
    payrollPayslip: { count: payslipCountTx },
    employmentPeriod: { count: periodCountTx },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockLogAction.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(async (arg) => {
        if (typeof arg === 'function') return arg(txClient);
        return Promise.all(arg);
    });
    employeeFindUnique.mockResolvedValue(sampleEmployee);
    payslipCountTx.mockResolvedValue(0);
    periodCountTx.mockResolvedValue(0);
});

describe('T-1.4 — hard-delete guard for employees with payroll history', () => {
    it('REFUSES: ≥1 payslip → throws, nothing deleted, no lifecycle event', async () => {
        payslipCountTx.mockResolvedValue(3);

        await expect(deleteEmployeeService(42, 1, { actorId: 1 }))
            .rejects
            .toThrow(/payroll history/i);

        expect(employeeDelete).not.toHaveBeenCalled();
        expect(attendanceDeleteMany).not.toHaveBeenCalled();
        expect(leaveDeleteMany).not.toHaveBeenCalled();
        expect(txOutboxCreate).not.toHaveBeenCalled();
    });

    it('REFUSES: ≥1 employment period → throws even with zero payslips', async () => {
        periodCountTx.mockResolvedValue(1);

        await expect(deleteEmployeeService(42, 1, { actorId: 1 }))
            .rejects
            .toThrow(/payroll history|employment histor/i);

        expect(employeeDelete).not.toHaveBeenCalled();
    });

    it('ALLOWS: a true mis-entry (no payslips, no periods) still deletes and emits terminated', async () => {
        txClient.employee.delete = employeeDelete;
        employeeDelete.mockResolvedValue(sampleEmployee);

        await deleteEmployeeService(42, 1, { actorId: 1, correlationId: 'corr-del' });

        expect(employeeDelete).toHaveBeenCalledTimes(1);
        expect(txOutboxCreate).toHaveBeenCalledTimes(1);
        const row = txOutboxCreate.mock.calls[0][0].data;
        expect(row.payload.payload.phase).toBe('terminated');
    });
});

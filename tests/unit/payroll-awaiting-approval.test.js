// The attendance decision must not move the numbers of a payroll that is
// already with its approvers: the PAYROLL approval digest covers every payslip
// amount and line, so rewriting one only makes the next approver's click fail
// with "The request or evidence changed".
//
// The end-to-end refusal on a COMPLETED run is asserted in
// tests/approval/attendanceResolutionRequest.test.mjs. The APPROVED branch
// cannot be staged over raw SQL (a trigger requires a real staged PAYROLL
// approval), so its message is asserted here.
import { describe, expect, it } from '@jest/globals';
import {
  assertPayrollNotAwaitingApproval,
  payrollAwaitingApprovalFor,
  payrollMonthLabel,
} from '../../src/services/attendanceRulePayroll.service.js';

const october = new Date(Date.UTC(2026, 9, 1));
const day = new Date(Date.UTC(2026, 9, 26));

const fakeDb = (row) => {
  const calls = [];
  return {
    calls,
    db: {
      payrollRun: {
        findFirst: async (args) => {
          calls.push(args);
          return row;
        },
      },
    },
  };
};

const args = { tenantId: 't-1', employeeId: 42, date: day };

describe('attendance decisions vs a payroll with its approvers', () => {
  it('looks only at that employee\'s slip in a COMPLETED or APPROVED run', async () => {
    const { db, calls } = fakeDb(null);
    expect(await payrollAwaitingApprovalFor(db, args)).toBeNull();
    expect(calls[0].where).toMatchObject({
      tenantId: 't-1',
      status: { in: ['COMPLETED', 'APPROVED'] },
      payslips: { some: { employeeId: 42 } },
    });
    expect(calls[0].where.periodStart).toEqual({ lte: day });
    expect(calls[0].where.periodEnd).toEqual({ gte: day });
  });

  it('lets the decision through when no run is with its approvers', async () => {
    const { db } = fakeDb(null);
    await expect(assertPayrollNotAwaitingApproval(db, args)).resolves.toBeUndefined();
  });

  it('refuses while the run waits at its approvers, naming the month', async () => {
    const { db } = fakeDb({ id: 7, status: 'COMPLETED', periodStart: october });
    await expect(assertPayrollNotAwaitingApproval(db, args)).rejects.toMatchObject({
      status: 409,
      message:
        'Payroll for October 2026 is with its approvers. Return the run to the initiator before deciding this case.',
    });
  });

  it('refuses an approved run that is waiting to be finalized', async () => {
    const { db } = fakeDb({ id: 8, status: 'APPROVED', periodStart: october });
    await expect(assertPayrollNotAwaitingApproval(db, args)).rejects.toMatchObject({
      status: 409,
      message:
        'Payroll for October 2026 is approved and awaiting finalization. Finalize it, then decide this case.',
    });
  });

  it('labels the payroll month in UTC', () => {
    expect(payrollMonthLabel(new Date(Date.UTC(2026, 9, 31, 23)))).toBe('October 2026');
  });
});

// The attendance decision must not move the numbers of a payroll that is
// already with its approvers: the PAYROLL approval digest covers every payslip
// amount and line, so rewriting one only makes the next approver's click fail
// with "The request or evidence changed".
//
// A COMPLETED run that was never submitted is not with anybody: no digest
// exists, so the decision is allowed and the run must be recalculated before it
// is submitted. Refusing there deadlocked October 2026 (a case raised after the
// run was processed blocked the recalculation, and the run blocked the case).
//
// The end-to-end refusal on a COMPLETED run with a live PAYROLL request is
// asserted in tests/approval/attendanceResolutionRequest.test.mjs. The APPROVED
// branch cannot be staged over raw SQL (a trigger requires a real staged
// PAYROLL approval), so its message is asserted here.
import { describe, expect, it } from '@jest/globals';
import {
  assertPayrollNotAwaitingApproval,
  payrollAwaitingApprovalFor,
  payrollAwaitingSubmitApproval,
  payrollMonthLabel,
} from '../../src/services/attendanceRulePayroll.service.js';

const october = new Date(Date.UTC(2026, 9, 1));
const day = new Date(Date.UTC(2026, 9, 26));

const fakeDb = (row, approval = null) => {
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
      hrApprovalRequest: {
        findUnique: async (args) => {
          calls.push(args);
          return approval;
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

  it('refuses a COMPLETED run whose PAYROLL request is with its approvers', async () => {
    const { db } = fakeDb({ id: 7, status: 'COMPLETED', periodStart: october }, { stage: 'HR' });
    await expect(assertPayrollNotAwaitingApproval(db, args)).rejects.toMatchObject({
      status: 409,
      message:
        'Payroll for October 2026 is with its approvers. Return the run to the initiator before deciding this case.',
    });
  });

  it('refuses a run whose PAYROLL request sits at Management', async () => {
    const { db } = fakeDb({ id: 7, status: 'COMPLETED', periodStart: october }, { stage: 'MANAGEMENT' });
    await expect(assertPayrollNotAwaitingApproval(db, args)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses an approved run that is waiting to be finalized', async () => {
    const { db } = fakeDb({ id: 8, status: 'APPROVED', periodStart: october }, { stage: 'APPROVED' });
    await expect(assertPayrollNotAwaitingApproval(db, args)).rejects.toMatchObject({
      status: 409,
      message:
        'Payroll for October 2026 is approved and awaiting finalization. Finalize it, then decide this case.',
    });
  });

  it('allows the decision on a COMPLETED run that was never submitted', async () => {
    const { db } = fakeDb({ id: 32, status: 'COMPLETED', periodStart: october }, null);
    await expect(assertPayrollNotAwaitingApproval(db, args)).resolves.toBeUndefined();
  });

  it('allows the decision on a run returned to its initiator or withdrawn', async () => {
    for (const stage of ['INITIATOR', 'REJECTED', 'WITHDRAWN']) {
      const { db } = fakeDb({ id: 33, status: 'COMPLETED', periodStart: october }, { stage });
      await expect(assertPayrollNotAwaitingApproval(db, args)).resolves.toBeUndefined();
    }
  });

  it('counts only a live stage as awaiting submission', async () => {
    const asked = [];
    const db = {
      hrApprovalRequest: {
        findUnique: async (where) => {
          asked.push(where.where.tenantId_kind_sourceRef);
          return { stage: 'MANAGEMENT' };
        },
      },
    };
    expect(await payrollAwaitingSubmitApproval(db, { tenantId: 't-1', payrollRunId: 32 })).toBe(true);
    expect(asked[0]).toEqual({ tenantId: 't-1', kind: 'PAYROLL', sourceRef: '32' });
  });

  it('labels the payroll month in UTC', () => {
    expect(payrollMonthLabel(new Date(Date.UTC(2026, 9, 31, 23)))).toBe('October 2026');
  });
});

// TS-APPROVAL-MATRIX-01 — payroll-run approval routes down the approval matrix
// (operator item 3.3, 2026-09-17): the approving employee must be a DESIGNATED
// approver (an ACTIVE PayrollApprovalMatrix level with their employee id).
//   • non-designated approver → HR-2013 refusal, run untouched
//   • designated approver → APPROVED, approvedBy/At stamped
//   • NO matrix rows → legacy behaviour (approval possible; audit notes it)
//   • matrix rows where NO level has a resolved approver → approval blocked
//     (an unresolvable matrix must not silently disable the control)
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 't-matrix';
const RUN_ID = 42;

const state = { run: null, matrix: [], auditRows: [] };

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    payrollRun: {
      findFirst: jest.fn(async () => state.run),
      updateMany: jest.fn(async ({ data }) => { Object.assign(state.run, data); return { count: 1 }; }),
    },
    payrollApprovalMatrix: {
      findMany: jest.fn(async () => state.matrix),
    },
    payrollAuditLog: {
      create: jest.fn(async ({ data }) => { state.auditRows.push(data); return { id: 1, ...data }; }),
    },
    // getPayrollRunById re-reads; return the mutated row.
  },
}));

jest.unstable_mockModule('../../src/utils/logs.js', () => ({
  logAction: jest.fn(async () => {}),
}));

const { approvePayrollRun } = await import('../../src/services/payrollService.js');

const processedRun = () => ({
  id: RUN_ID,
  status: 'COMPLETED',
  processedBy: 900, // someone other than any approver used here
  approvedBy: null,
  approvedAt: null,
});

beforeEach(() => {
  state.run = processedRun();
  state.matrix = [];
  state.auditRows = [];
});

describe('TS-APPROVAL-MATRIX-01 — approval routes down the matrix', () => {
  it('approves when the approver is a designated matrix approver', async () => {
    state.matrix = [
      { level: 1, approverId: 558, role: 'HR' },
      { level: 2, approverId: 8, role: 'MANAGEMENT' },
    ];
    const res = await approvePayrollRun(RUN_ID, 558, TENANT);
    expect(res.status).toBe('APPROVED');
    expect(res.approvedBy).toBe(558);
    expect(state.auditRows[0].details).toContain('approval-matrix enforced');
  });

  it('refuses a non-designated approver (HR-2013) and leaves the run untouched', async () => {
    state.matrix = [{ level: 1, approverId: 558, role: 'HR' }];
    await expect(approvePayrollRun(RUN_ID, 777, TENANT)).rejects.toThrow('HR-2013');
    expect(state.run.status).toBe('COMPLETED');
    expect(state.run.approvedBy).toBeNull();
  });

  it('keeps legacy behaviour when no matrix rows exist (audit notes it)', async () => {
    state.matrix = [];
    const res = await approvePayrollRun(RUN_ID, 558, TENANT);
    expect(res.status).toBe('APPROVED');
    expect(state.auditRows[0].details).toContain('no approval matrix configured');
  });

  it('blocks approval when the matrix exists but no level has a resolved approver', async () => {
    state.matrix = [
      { level: 1, approverId: null, role: 'HR' },
      { level: 2, approverId: null, role: 'MANAGEMENT' },
    ];
    await expect(approvePayrollRun(RUN_ID, 558, TENANT)).rejects.toThrow('HR-2013');
    expect(state.run.status).toBe('COMPLETED');
  });
});

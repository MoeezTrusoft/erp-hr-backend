// C1 (plan 25) / T-3.1 — [A-08] separation of duties for bulk payslip actions.
//
// bulkPayslipAction('approve') sets APPROVED with no check that the actor is
// someone OTHER than the run's processor — the run-level gate enforces
// approver≠processor (HR-PAY-06), so the same person can approve their own
// processing one payslip at a time through the bulk lane.
//
// Contract: bulk APPROVE refuses when the actor processed any target run (403,
// message names the offending run). hold/disburse are unaffected; a legacy run
// with processedBy=null cannot establish a violation.
// Red = no check exists, the approve below succeeds silently.
import { jest, describe, it, expect, beforeAll } from '@jest/globals';

const payslipRows = [
  { id: 11, payrollRunId: 3 },
  { id: 12, payrollRunId: 3 },
  { id: 13, payrollRunId: 4 },
];
const runRows = [
  { id: 3, processedBy: 501 }, // processed by the offending actor
  { id: 4, processedBy: null }, // legacy: no processor recorded
];
const updates = [];

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    payrollPayslip: {
      findMany: jest.fn(async ({ where }) => payslipRows.filter((p) => where.id.in.includes(p.id))),
      updateMany: jest.fn(async ({ where, data }) => { updates.push(data); return { count: where.id.in.length }; }),
    },
    payrollRun: {
      findMany: jest.fn(async ({ where }) => runRows.filter((r) => where.id.in.includes(r.id))),
    },
  },
}));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: async (prisma, fn) => fn(prisma),
}));

let bulkPayslipAction;
beforeAll(async () => {
  ({ bulkPayslipAction } = await import('../../src/services/payrollDashboard.service.js'));
});

describe('[A-08] bulk-approve separation of duties', () => {
  it('refuses bulk approve when the actor processed a target run (403, names the run)', async () => {
    await expect(bulkPayslipAction({
      tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
      payslipIds: [11, 12, 13],
      action: 'approve',
      actorId: 501,
    })).rejects.toMatchObject({ status: 403 });
    await expect(bulkPayslipAction({
      tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
      payslipIds: [11, 12, 13],
      action: 'approve',
      actorId: 501,
    })).rejects.toThrow(/run 3/);
  });

  it('allows bulk approve by a different person than the processor', async () => {
    updates.length = 0;
    const res = await bulkPayslipAction({
      tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
      payslipIds: [11, 12, 13],
      action: 'approve',
      actorId: 777,
    });
    expect(res.updated).toBe(3);
    expect(updates[0].status).toBe('APPROVED');
  });

  it('does not gate hold / disburse on processor identity', async () => {
    await expect(bulkPayslipAction({
      tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
      payslipIds: [11], action: 'hold', reason: 'dispute', actorId: 501,
    })).resolves.toBeTruthy();
    await expect(bulkPayslipAction({
      tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
      payslipIds: [11], action: 'disburse', actorId: 501,
    })).resolves.toBeTruthy();
  });

  it('cannot establish a violation from a legacy run with no processor', async () => {
    // payslip 13 → run 4 (processedBy null); actor 501 processed run 3 only,
    // so approving ONLY 13 must succeed even for actor 501.
    const res = await bulkPayslipAction({
      tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
      payslipIds: [13],
      action: 'approve',
      actorId: 501,
    });
    expect(res.updated).toBe(1);
  });
});

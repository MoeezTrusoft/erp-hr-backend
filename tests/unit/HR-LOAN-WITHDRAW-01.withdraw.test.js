// HR-LOAN-WITHDRAW-01 — an employee may withdraw their own loan or salary advance
// request while it waits, like leave, overtime and claims. The full engine path
// (stages, queues, the DB source guard) is in tests/approval/workflow.postgres.
import { jest, describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';

const reached = new Error('reached the transaction');
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: jest.fn(async () => { throw reached; }),
  rlsTenantExtension: (c) => c,
  isTenantTransaction: () => false,
}));
jest.unstable_mockModule('../../src/mcp/context.js', () => ({
  getCtx: () => ({ actorVerified: true, permissions: ['hr.approvals.self'], user: { tenantId: 't1' } }),
  mcpCtx: { getStore: () => null, run: (_c, fn) => fn() },
}));

const { legacyWithdraw } = await import('../../src/services/approval/legacy.js');

describe('loan withdrawal', () => {
  it('a LOAN request passes the kind gate (it used to be refused outright)', async () => {
    await expect(legacyWithdraw('LOAN', '7')).rejects.toBe(reached);
  });
  it('kinds that cannot be withdrawn are still refused before any read', async () => {
    await expect(legacyWithdraw('PAYROLL', '7')).rejects.toThrow(/cannot be withdrawn/);
  });
  it('the database knows the WITHDRAWN loan status', () => {
    expect(readFileSync('prisma/schema.prisma', 'utf8')).toMatch(/enum LoanStatus \{[^}]*WITHDRAWN/);
    expect(readFileSync('prisma/migrations/20261127120000_loan_status_withdrawn/migration.sql', 'utf8'))
      .toMatch(/ALTER TYPE "LoanStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN'/);
  });
});

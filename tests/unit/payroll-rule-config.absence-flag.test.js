// T-0.3 — PayrollRuleConfig.absenceRecoveryEnabled (N-01 enabler, plan 20).
//
// The flag is enabled by default because the authoritative attendance policy
// prices unexcused ABSENT/HALF_DAY day-credit loss. Approved anomaly requests
// remain exempt in the payroll bridge.
import { jest } from '@jest/globals';

const prismaMock = {
  payrollRuleConfig: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    upsert: jest.fn(),
  },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: jest.fn(async (_prisma, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const { getPayrollRules, updatePayrollRules } = await import('../../src/services/payrollRuleConfig.service.js');

describe('T-0.3 PayrollRuleConfig.absenceRecoveryEnabled', () => {
  beforeEach(() => jest.clearAllMocks());

  test('default config reports absenceRecoveryEnabled: true', async () => {
    prismaMock.payrollRuleConfig.findUnique.mockResolvedValue(null);
    const rules = await getPayrollRules({ tenantId: 't-uuid' });
    expect(rules.absenceRecoveryEnabled).toBe(true);
  });

  test('persisted row carries the flag through untouched', async () => {
    prismaMock.payrollRuleConfig.findUnique.mockResolvedValue({
      id: 1,
      absenceRecoveryEnabled: true,
      lwpRecovery: true,
    });
    const rules = await getPayrollRules({ tenantId: 't-uuid' });
    expect(rules.absenceRecoveryEnabled).toBe(true);
  });

  test('updatePayrollRules persists absenceRecoveryEnabled like the other toggles', async () => {
    prismaMock.payrollRuleConfig.upsert.mockImplementation(async ({ update }) => ({ id: 1, ...update }));
    await updatePayrollRules({ tenantId: 't-uuid', absenceRecoveryEnabled: true });
    expect(prismaMock.payrollRuleConfig.upsert).toHaveBeenCalledTimes(1);
    const arg = prismaMock.payrollRuleConfig.upsert.mock.calls[0][0];
    expect(arg.update.absenceRecoveryEnabled).toBe(true);
    expect(arg.create.absenceRecoveryEnabled).toBe(true);
  });

  test('updatePayrollRules does not touch the flag when it is not provided', async () => {
    prismaMock.payrollRuleConfig.upsert.mockImplementation(async ({ update }) => ({ id: 1, ...update }));
    await updatePayrollRules({ tenantId: 't-uuid', lwpRecovery: false });
    const arg = prismaMock.payrollRuleConfig.upsert.mock.calls[0][0];
    expect(arg.update.absenceRecoveryEnabled).toBeUndefined();
    expect(arg.create.absenceRecoveryEnabled).toBeUndefined();
  });
});

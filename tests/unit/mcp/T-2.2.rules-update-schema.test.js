// T-2.2 — hr_payroll_rules_update must expose every toggle the config service
// accepts. The zod facade previously predated absenceRecoveryEnabled /
// deductionBasis / EOBI, so doc 22's fleet-wide flag step would have been
// silently stripped at the tool boundary (service supports it, zod drops it).
// This pins the tool schema to the service contract.
import { jest, describe, it, expect } from '@jest/globals';
import { z } from 'zod';

jest.unstable_mockModule('../../../src/services/payrollRuleConfig.service.js', () => ({
  getPayrollRules: jest.fn(async () => ({ id: 1 })),
  updatePayrollRules: jest.fn(async (args) => ({ ok: true, received: args })),
}));
jest.unstable_mockModule('../../../src/services/payrollConfigActions.service.js', () => ({
  getGlobalKpis: jest.fn(),
  getConfigStatus: jest.fn(),
  publishConfig: jest.fn(),
  exportConfig: jest.fn(),
}));

const { registerPayrollSetupActionsTools } = await import('../../../src/mcp/tools/payrollSetupActionsTools.js');
const svc = await import('../../../src/services/payrollRuleConfig.service.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = { tool: (name, ...rest) => handlers.set(name, rest), resource: () => {} };
registerPayrollSetupActionsTools(recording);

const USER = { userId: '7', tenantId: '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007', isAdmin: false };
const call = (args) => mcpCtx.run({ user: USER, permissions: { 'hr:payroll': ['EDIT'] } }, async () => {
  const [, shape, handler] = handlers.get('hr_payroll_rules_update');
  // server.tool receives a zod RAW SHAPE; the SDK wraps it in z.object().
  const parsed = z.object(shape).parse(args);
  return handler(parsed);
});

describe('T-2.2 — hr_payroll_rules_update passes the signed config surface through zod', () => {
  it('accepts absenceRecoveryEnabled and forwards it to the service', async () => {
    await call({ absenceRecoveryEnabled: true });
    expect(svc.updatePayrollRules).toHaveBeenCalledWith(
      expect.objectContaining({ absenceRecoveryEnabled: true }),
    );
  });

  it('accepts deductionBasis and EOBI fields and forwards them', async () => {
    await call({
      deductionBasis: 'GROSS',
      eobiEnabled: false,
      eobiEmployeeRatePct: 1,
      eobiWageCeilingMinor: 1700000,
    });
    expect(svc.updatePayrollRules).toHaveBeenCalledWith(
      expect.objectContaining({
        deductionBasis: 'GROSS',
        eobiEnabled: false,
        eobiEmployeeRatePct: 1,
        eobiWageCeilingMinor: 1700000,
      }),
    );
  });
});

// B2 (plan 25) / T-2.8 — the MCP facade for the seed tool: schema shape,
// admin gate, and service forwarding (same harness as T-2.2.rules-update).
import { jest, describe, it, expect } from '@jest/globals';
import { z } from 'zod';

jest.unstable_mockModule('../../../src/services/payrollRuleConfig.service.js', () => ({
  getPayrollRules: jest.fn(),
  updatePayrollRules: jest.fn(),
}));
jest.unstable_mockModule('../../../src/services/payrollConfigActions.service.js', () => ({
  getGlobalKpis: jest.fn(),
  getConfigStatus: jest.fn(),
  publishConfig: jest.fn(),
  exportConfig: jest.fn(),
}));
const seedSvc = { seedConfigFromTenant: jest.fn(async (args) => ({ ok: true, ...args })) };
jest.unstable_mockModule('../../../src/services/payrollConfigSeed.service.js', () => seedSvc);

const { registerPayrollSetupActionsTools } = await import('../../../src/mcp/tools/payrollSetupActionsTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = { tool: (name, ...rest) => handlers.set(name, rest), resource: () => {} };
registerPayrollSetupActionsTools(recording);

const USER = { userId: '7', tenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523', isAdmin: true };
const call = (args, user = USER, perms = { 'hr:payroll': ['EDIT', 'CREATE'] }) =>
  mcpCtx.run({ user, permissions: perms }, async () => {
    const [, shape, handler] = handlers.get('hr_payroll_config_seed_from_tenant');
    const parsed = z.object(shape).parse(args);
    return handler(parsed);
  });

describe('T-2.8 — hr_payroll_config_seed_from_tenant facade', () => {
  it('is registered and forwards parsed uuid args to the service', async () => {
    expect(handlers.has('hr_payroll_config_seed_from_tenant')).toBe(true);
    await call({
      sourceTenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
      targetTenantId: '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73',
    });
    expect(seedSvc.seedConfigFromTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523',
        targetTenantId: '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73',
        actorIsAdmin: true,
      }),
    );
  });

  it('rejects a non-uuid target (zod contract)', async () => {
    await expect(call({ sourceTenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523', targetTenantId: '6' }))
      .rejects.toBeTruthy();
  });

  it('keeps the admin gate: non-admin actor still reaches the service which refuses', async () => {
    // The tool forwards actorIsAdmin:false; the SERVICE throws 403 (tested in
    // T-2.8.config-seed-from-tenant). Here we pin the facade passes it through.
    await call(
      { sourceTenantId: '40314ef4-0a81-4390-b631-b3ad3f21f523', targetTenantId: '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73' },
      { ...USER, isAdmin: false },
    );
    expect(seedSvc.seedConfigFromTenant).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorIsAdmin: false }),
    );
  });
});

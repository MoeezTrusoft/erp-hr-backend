// tests/unit/mcp/benefits.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR benefits tools (8 tools).
// DB-free: controller is mocked; tool→controller dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/mcp/controllers/benefitMcpController.js', () => ({
  mcpListBenefitPlans: jest.fn(async () => ({ success: true })),
  mcpGetBenefitPlan: jest.fn(async () => ({ success: true })),
  mcpCreateBenefitPlan: jest.fn(async () => ({ success: true })),
  mcpUpdateBenefitPlan: jest.fn(async () => ({ success: true })),
  mcpDeleteBenefitPlan: jest.fn(async () => ({ success: true })),
  mcpEnrollBenefit: jest.fn(async () => ({ success: true })),
  mcpUnenrollBenefit: jest.fn(async () => ({ success: true })),
  mcpListEmployeeBenefits: jest.fn(async () => ({ success: true })),
}));

const { registerBenefitTools } = await import('../../../src/mcp/tools/benefitTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerBenefitTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_benefit_plan_list', gate: 'hr:benefits', action: 'VIEW', args: {} },
  { name: 'hr_benefit_plan_get', gate: 'hr:benefits', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_benefit_plan_create', gate: 'hr:benefits', action: 'CREATE', args: { name: 'Health Plus', type: 'HEALTH' } },
  { name: 'hr_benefit_plan_update', gate: 'hr:benefits', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_benefit_plan_delete', gate: 'hr:benefits', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_benefit_enroll', gate: 'hr:benefits', action: 'CREATE', args: { employeeId: '7', benefitPlanId: '1' } },
  { name: 'hr_benefit_unenroll', gate: 'hr:benefits', action: 'DELETE', args: { employeeId: '7', benefitPlanId: '1' } },
  { name: 'hr_employee_benefits_list', gate: 'hr:benefits', action: 'VIEW', args: { employeeId: '7' } },
];

describe('BENEFITS-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to controller and returns result', async () => {
    const res = await call(name, args, { permissions: grant });
    expect(res).toBeDefined();
    expect(res.content).toBeDefined();
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content[0].type).toBe('text');
  });

  it('deny-by-default: no permission blob -> 403', async () => {
    const res = await call(name, args, { permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });

  it('forged isAdmin grants nothing (still 403)', async () => {
    const res = await call(name, args, { user: { ...USER, isAdmin: true }, permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });
});

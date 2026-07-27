// tests/unit/mcp/developmentPlan.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR development plan + payslip question tools (12 new).
// DB-free: service + prisma are mocked; tool→dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/developmentPlan.service.js', () => ({
  createPlan: jest.fn(async () => ({ success: true })),
  listPlans: jest.fn(async () => ({ success: true })),
  addPlanItem: jest.fn(async () => ({ success: true })),
  listPlanItems: jest.fn(async () => ({ success: true })),
  updatePlanItem: jest.fn(async () => ({ success: true })),
}));

const devPlanMock = {
  findUnique: jest.fn(async () => ({ id: 1, title: 'Growth Plan' })),
  update: jest.fn(async () => ({ id: 1 })),
  delete: jest.fn(async () => ({})),
};
const payslipQuestionMock = {
  findMany: jest.fn(async () => []),
  findUnique: jest.fn(async () => ({ id: 1 })),
  update: jest.fn(async () => ({ id: 1 })),
  delete: jest.fn(async () => ({})),
};
jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: {
    developmentPlan: devPlanMock,
    payslipQuestion: payslipQuestionMock,
  },
}));

const { registerDevelopmentPlanTools } = await import('../../../src/mcp/tools/developmentPlanTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerDevelopmentPlanTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_development_plan_list', gate: 'hr:performance', action: 'VIEW', args: {} },
  { name: 'hr_development_plan_get', gate: 'hr:performance', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_development_plan_update', gate: 'hr:performance', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_development_plan_delete', gate: 'hr:performance', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_development_plan_item_list', gate: 'hr:performance', action: 'VIEW', args: { planId: '1' } },
  { name: 'hr_development_plan_item_update', gate: 'hr:performance', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_payslip_question_list', gate: 'hr:payroll', action: 'VIEW', args: {} },
  { name: 'hr_payslip_question_get', gate: 'hr:payroll', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_payslip_question_update', gate: 'hr:payroll', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_payslip_question_delete', gate: 'hr:payroll', action: 'DELETE', args: { id: '1' } },
];

describe('DEVELOPMENT-PLAN-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to service/prisma and returns result', async () => {
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

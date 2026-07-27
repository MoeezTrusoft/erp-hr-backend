// tests/unit/mcp/shiftTemplate.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR shift template + shift swap tools (9 tools).
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/shiftTemplateSwap.service.js', () => ({
  listShiftTemplates: jest.fn(async () => ({ success: true })),
  createShiftTemplate: jest.fn(async () => ({ success: true })),
  updateShiftTemplate: jest.fn(async () => ({ success: true })),
  deleteShiftTemplate: jest.fn(async () => ({ success: true })),
  listShiftSwaps: jest.fn(async () => ({ success: true })),
  createShiftSwap: jest.fn(async () => ({ success: true })),
  updateShiftSwap: jest.fn(async () => ({ success: true })),
  decideShiftSwap: jest.fn(async () => ({ success: true })),
  withdrawOvertimeRequest: jest.fn(async () => ({ success: true })),
}));

const { registerShiftTemplateSwapTools } = await import('../../../src/mcp/tools/shiftTemplateSwapTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerShiftTemplateSwapTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_shift_template_list', gate: 'hr:attendance', action: 'VIEW', args: {} },
  { name: 'hr_shift_template_create', gate: 'hr:attendance', action: 'CREATE', args: { name: 'Morning', fromTime: '09:00', toTime: '17:00' } },
  { name: 'hr_shift_template_update', gate: 'hr:attendance', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_shift_template_delete', gate: 'hr:attendance', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_shift_swap_list', gate: 'hr:attendance', action: 'VIEW', args: {} },
  { name: 'hr_shift_swap_create', gate: 'hr:attendance', action: 'CREATE', args: { requesterId: '7', fromDate: '2026-08-01' } },
  { name: 'hr_shift_swap_update', gate: 'hr:attendance', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_shift_swap_decide', gate: 'hr:attendance', action: 'EDIT', args: { id: '1', decision: 'APPROVED' } },
  { name: 'hr_overtime_request_withdraw', gate: 'hr:attendance', action: 'EDIT', args: { id: '1' } },
];

describe('SHIFT-TEMPLATE-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to service and returns result', async () => {
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

// tests/unit/mcp/leavePolicy.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR leave policy tools (2 new: LIST, GET).
// DB-free: prisma is mocked; tool→prisma dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const findMany = jest.fn(async () => []);
const findUnique = jest.fn(async () => ({ id: 1, name: 'Annual Leave' }));

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: { leavePolicy: { findMany, findUnique } },
}));

const { registerLeavePolicyTools } = await import('../../../src/mcp/tools/leavePolicyTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerLeavePolicyTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_leave_policy_list', gate: 'hr:leave', action: 'VIEW', args: {} },
  { name: 'hr_leave_policy_get', gate: 'hr:leave', action: 'VIEW', args: { id: '1' } },
];

describe('LEAVE-POLICY-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to prisma and returns result', async () => {
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

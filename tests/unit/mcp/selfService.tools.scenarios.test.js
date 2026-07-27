// tests/unit/mcp/selfService.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR self-service tools (3 tools).
// DB-free: controller is mocked; tool→controller dispatch + auth gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/mcp/controllers/selfMcpController.js', () => ({
  mcpCreateSelfLeaveRequest: jest.fn(async () => ({ success: true })),
  mcpGetSelfAttendance: jest.fn(async () => ({ success: true })),
  mcpGetSelfLeaveBalances: jest.fn(async () => ({ success: true })),
  mcpGetSelfPayslips: jest.fn(async () => ({ success: true })),
  mcpGetSelfProfile: jest.fn(async () => ({ success: true })),
  mcpSelfCheckin: jest.fn(async () => ({ success: true })),
  mcpUpdateSelfProfile: jest.fn(async () => ({ success: true })),
}));

const { registerSelfTools } = await import('../../../src/mcp/tools/selfTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerSelfTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_self_update_profile', args: {} },
  { name: 'hr_self_leave_request', args: { leavePolicyId: '1', startDate: '2026-01-15', endDate: '2026-01-17' } },
  { name: 'hr_self_checkin', args: {} },
];

describe('SELF-SERVICE-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, args }) => {
  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to controller and returns result', async () => {
    const res = await call(name, args, { permissions: {} });
    expect(res).toBeDefined();
    expect(res.content).toBeDefined();
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content[0].type).toBe('text');
    const body = parse(res);
    expect(body.success).toBe(true);
  });

  it('unauthenticated: no user context -> 401', async () => {
    const res = await mcpCtx.run({}, () => handlers.get(name)(args));
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(401);
  });
});

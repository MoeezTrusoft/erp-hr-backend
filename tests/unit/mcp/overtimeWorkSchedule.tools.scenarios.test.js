// tests/unit/mcp/overtimeWorkSchedule.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR overtime rule list + work schedule list (2 new).
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/overtimeService.js', () => ({
  getOvertimeRules: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/services/workScheduleService.js', () => ({
  getWorkSchedules: jest.fn(async () => ({ success: true })),
}));

const { registerOvertimeWorkScheduleTools } = await import('../../../src/mcp/tools/overtimeWorkScheduleTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerOvertimeWorkScheduleTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_overtime_rule_list', gate: 'hr:attendance', action: 'VIEW', args: {} },
  { name: 'hr_work_schedule_list', gate: 'hr:attendance', action: 'VIEW', args: {} },
];

describe('OVERTIME-WORK-SCHEDULE-SCENARIOS — registration', () => {
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

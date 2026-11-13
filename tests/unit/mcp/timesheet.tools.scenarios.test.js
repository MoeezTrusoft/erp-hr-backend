// tests/unit/mcp/timesheet.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR timesheet tools (3 new: LIST, GET, CREATE).
// DB-free: service is mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/timesheetService.js', () => ({
  getTimesheets: jest.fn(async () => ({ success: true })),
  getTimesheetById: jest.fn(async () => ({ success: true })),
  createTimesheet: jest.fn(async () => ({ success: true })),
}));

const { registerTimesheetTools } = await import('../../../src/mcp/tools/timesheetTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerTimesheetTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_timesheet_list', gate: 'hr:timesheet', action: 'VIEW', args: {} },
  { name: 'hr_timesheet_get', gate: 'hr:timesheet', action: 'VIEW', args: { id: '1', employeeId: '7' } },
  { name: 'hr_timesheet_create', gate: 'hr:timesheet', action: 'CREATE', args: { employeeId: '7', periodStart: '2026-08-01', periodEnd: '2026-08-07' } },
];

describe('TIMESHEET-SCENARIOS — registration', () => {
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

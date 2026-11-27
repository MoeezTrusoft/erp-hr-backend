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
  getRosterCoverage: jest.fn(async () => ({
    date: '2026-09-20',
    activeEmployees: 1,
    withScheduleInForce: 1,
    missingCount: 0,
    missing: [],
  })),
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
  // Coverage lists who in the company has no roster: HR's attendance write surface.
  { name: 'hr_work_schedule_coverage', gate: 'hr:attendance', action: 'VIEW', args: { date: '2026-09-20' }, extra: ['EDIT'] },
];

describe('OVERTIME-WORK-SCHEDULE-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, gate, action, args, extra = [] }) => {
  const grant = { [gate]: [action, ...extra] };

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

describe('HR-ROSTER-SCOPE-01 — an employee sees only their own roster', () => {
  let svc;
  beforeEach(async () => {
    jest.clearAllMocks();
    svc = await import('../../../src/services/workScheduleService.js');
  });
  const EMPLOYEE = { permissions: { 'hr:attendance': ['VIEW'] } };
  it('the list is pinned to the acting employee', async () => {
    await call('hr_work_schedule_list', {}, EMPLOYEE);
    expect(svc.getWorkSchedules).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7 }));
  });
  it("asking for someone else's roster is refused", async () => {
    const res = await call('hr_work_schedule_list', { employeeId: 12 }, EMPLOYEE);
    expect(parse(res).status).toBe(403);
    expect(svc.getWorkSchedules).not.toHaveBeenCalled();
  });
  it('HR (attendance write) lists the company', async () => {
    await call('hr_work_schedule_list', {}, { permissions: { 'hr:attendance': ['VIEW', 'EDIT'] } });
    expect(svc.getWorkSchedules.mock.calls[0][0].employeeId).toBeUndefined();
  });
  it('coverage is refused to an employee', async () => {
    const res = await call('hr_work_schedule_coverage', {}, EMPLOYEE);
    expect(parse(res).status).toBe(403);
    expect(svc.getRosterCoverage).not.toHaveBeenCalled();
  });
});

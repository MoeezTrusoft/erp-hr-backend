// tests/unit/mcp/org.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR org chart tools (4 tools).
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/rbac.client.js', () => ({
  listDepartments: jest.fn(async () => ({ success: true })),
  getDepartmentById: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/services/orgChartView.service.js', () => ({
  getDepartmentView: jest.fn(async () => ({ success: true })),
  getOrgChartRows: jest.fn(async () => []),
  orgChartToPNG: jest.fn(async () => Buffer.from('png')),
}));
jest.unstable_mockModule('../../../src/lib/export.util.js', () => ({
  exportRows: jest.fn(async () => ''),
}));

const { registerOrgTools } = await import('../../../src/mcp/tools/orgTools.js');
const { registerOrgChartTools } = await import('../../../src/mcp/tools/orgChartTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerOrgTools(recording);
registerOrgChartTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_departments_list', gate: 'hr:employee', action: 'VIEW', args: {} },
  { name: 'hr_department_get', gate: 'hr:employee', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_org_chart_departments', gate: 'hr:employee', action: 'VIEW', args: {} },
  { name: 'hr_org_chart_export', gate: 'hr:employee', action: 'VIEW', args: { format: 'csv' } },
];

describe('ORG-SCENARIOS — registration', () => {
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

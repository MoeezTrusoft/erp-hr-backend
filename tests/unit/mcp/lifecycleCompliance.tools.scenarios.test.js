// tests/unit/mcp/lifecycleCompliance.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR lifecycle + compliance tools (12 new).
// DB-free: service + prisma are mocked; tool→dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/employeeLifecycle.service.js', () => ({
  listEvents: jest.fn(async () => ({ success: true })),
  getEmployeeHistory: jest.fn(async () => ({ success: true })),
  logEvent: jest.fn(async () => ({ success: true })),
}));

const complianceChecklistMock = {
  findMany: jest.fn(async () => []),
  findUnique: jest.fn(async () => ({ id: 1, name: 'Safety' })),
  update: jest.fn(async () => ({ id: 1 })),
  delete: jest.fn(async () => ({})),
  create: jest.fn(async () => ({ id: 1 })),
};
const complianceItemMock = {
  findMany: jest.fn(async () => []),
  findUnique: jest.fn(async () => ({ id: 1 })),
  create: jest.fn(async () => ({ id: 1 })),
  delete: jest.fn(async () => ({})),
};
jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: {
    complianceChecklist: complianceChecklistMock,
    complianceItem: complianceItemMock,
  },
}));

const { registerLifecycleComplianceTools } = await import('../../../src/mcp/tools/lifecycleComplianceTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerLifecycleComplianceTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_lifecycle_event_list', gate: 'hr:employee', action: 'VIEW', args: {} },
  { name: 'hr_lifecycle_event_get', gate: 'hr:employee', action: 'VIEW', args: { employeeId: '7' } },
  { name: 'hr_compliance_checklist_list', gate: 'hr:compliance', action: 'VIEW', args: {} },
  { name: 'hr_compliance_checklist_get', gate: 'hr:compliance', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_compliance_checklist_update', gate: 'hr:compliance', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_compliance_checklist_delete', gate: 'hr:compliance', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_compliance_item_list', gate: 'hr:compliance', action: 'VIEW', args: {} },
  { name: 'hr_compliance_item_get', gate: 'hr:compliance', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_compliance_item_create', gate: 'hr:compliance', action: 'CREATE', args: { checklistId: '1', title: 'Safety check' } },
  { name: 'hr_compliance_item_delete', gate: 'hr:compliance', action: 'DELETE', args: { id: '1' } },
];

describe('LIFECYCLE-COMPLIANCE-SCENARIOS — registration', () => {
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

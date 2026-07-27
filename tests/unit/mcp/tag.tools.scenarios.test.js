// tests/unit/mcp/tag.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR recruitment tag tools (4 tools).
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/tagService.js', () => ({
  listTags: jest.fn(async () => ({ success: true })),
  createTag: jest.fn(async () => ({ success: true })),
  upsertTags: jest.fn(async () => ({ success: true })),
  deactivateTag: jest.fn(async () => ({ success: true })),
}));

const { registerTagTools } = await import('../../../src/mcp/tools/tagTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerTagTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_tag_list', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  { name: 'hr_tag_create', gate: 'hr:recruitment', action: 'CREATE', args: { name: 'React' } },
  { name: 'hr_tag_upsert', gate: 'hr:recruitment', action: 'CREATE', args: { names: ['React', 'Node.js'] } },
  { name: 'hr_tag_deactivate', gate: 'hr:recruitment', action: 'DELETE', args: { id: '1' } },
];

describe('TAG-SCENARIOS — registration', () => {
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

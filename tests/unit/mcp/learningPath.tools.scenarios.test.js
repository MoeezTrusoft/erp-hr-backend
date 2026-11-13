// tests/unit/mcp/learningPath.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR learning path tools (5 new: LIST, GET, UPDATE, DELETE, ENROLL).
// DB-free: service is mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/learningPath.service.js', () => ({
  listPaths: jest.fn(async () => ({ success: true })),
  getPath: jest.fn(async () => ({ success: true })),
  updatePath: jest.fn(async () => ({ success: true })),
  addCourseToPath: jest.fn(async () => ({ success: true })),
  enrollEmployee: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: { learningPath: { delete: jest.fn(async () => ({})) } },
}));

const { registerLearningPathTools } = await import('../../../src/mcp/tools/learningPathTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerLearningPathTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_learning_path_list', gate: 'hr:learning', action: 'VIEW', args: {} },
  { name: 'hr_learning_path_get', gate: 'hr:learning', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_learning_path_update', gate: 'hr:learning', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_learning_path_delete', gate: 'hr:learning', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_learning_path_enroll', gate: 'hr:learning', action: 'CREATE', args: { pathId: '1', employeeId: '7' } },
];

describe('LEARNING-PATH-SCENARIOS — registration', () => {
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

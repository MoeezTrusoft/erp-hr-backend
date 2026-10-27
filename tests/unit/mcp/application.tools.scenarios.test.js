// tests/unit/mcp/application.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR application tools (2 new: LIST, GET).
// DB-free: service + prisma are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Phase 1.4 (remainder) — the tool file no longer touches prisma directly: GET
// and DELETE both go through applicationService, tenant + scope scoped.
const appService = {
  listApplications: jest.fn(async () => ({ success: true })),
  getApplication: jest.fn(async () => ({ id: 1, candidateId: 88 })),
  deleteApplication: jest.fn(async () => 1),
};
jest.unstable_mockModule('../../../src/services/applicationService.js', () => appService);
jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: { application: { findUnique: jest.fn(async () => ({ id: 1 })) } },
}));

const { registerApplicationTools } = await import('../../../src/mcp/tools/applicationTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerApplicationTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_application_list', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  { name: 'hr_application_get', gate: 'hr:recruitment', action: 'VIEW', args: { id: '1' } },
];

describe('APPLICATION-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });

  it('hr_application_delete is registered too', () => {
    expect(handlers.has('hr_application_delete')).toBe(true);
  });
});

describe('APPLICATION-SCENARIOS — tenant-scoped not-found', () => {
  const grant = { 'hr:recruitment': ['VIEW'] };

  beforeEach(() => jest.clearAllMocks());

  it('a row outside the tenant/scope reads as 404, not as someone else\'s data', async () => {
    appService.getApplication.mockResolvedValueOnce(null);

    const res = await call('hr_application_get', { id: '7' }, { permissions: grant });

    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(404);
  });

  it('delete refuses a row the caller does not own (404, no delete)', async () => {
    appService.deleteApplication.mockResolvedValueOnce(null);

    const res = await call(
      'hr_application_delete',
      { id: '7' },
      { permissions: { 'hr:recruitment': ['DELETE'] } }
    );

    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(404);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('hands the service the verified tenant and a resolved record scope', async () => {
    await call(name, args, { permissions: grant });

    const fn = name === 'hr_application_list' ? appService.listApplications : appService.getApplication;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-A' });
    // HR_ADMIN resolves to the organisation-wide scope, which is unrestricted.
    expect(fn.mock.calls[0][0].scope).toMatchObject({ level: 'ORG', unrestricted: true });
  });

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

// tests/unit/mcp/deduction.tools.scenarios.test.js
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  salaryComponent: {
    count: jest.fn(async () => 5),
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(),
    create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
    update: jest.fn(async ({ data }) => ({ id: 1, code: 'TAX-FED', name: 'Federal Tax', ...data })),
    delete: jest.fn(async () => ({ id: 1 })),
  },
  loan: { count: jest.fn(async () => 12) },
};

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({ default: mockPrisma }));

const { registerDeductionTools } = await import('../../../src/mcp/tools/deductionTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = { tool: (n, ...r) => handlers.set(n, r[r.length - 1]), resource: () => {} };
registerDeductionTools(recording);

const USER = { userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'], isAdmin: false, employeeId: '7', tenantId: 'tenant-A' };
const COMPONENT = { id: 1, code: 'TAX-FED', name: 'Federal Tax', type: 'DEDUCTION', computation: 'FIXED', formula: null, value: 1500, taxable: true, active: true, sortOrder: 0, status: 'PUBLISHED', createdAt: new Date(), updatedAt: new Date() };

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);
const GRANT = { 'hr:payroll': ['VIEW', 'CREATE', 'EDIT', 'DELETE'] };

const TOOLS = [
  { name: 'hr_deduction_kpi', args: {} },
  { name: 'hr_deduction_list', args: {} },
  { name: 'hr_deduction_get', args: { id: '1' } },
  { name: 'hr_deduction_create', args: { code: 'TAX-NEW', name: 'New Tax' } },
  { name: 'hr_deduction_update', args: { id: '1', name: 'Updated' } },
  { name: 'hr_deduction_delete', args: { id: '1' } },
];

describe('DEDUCTION — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (n) => expect(handlers.has(n)).toBe(true));
});

describe.each(TOOLS)('$name scenarios', ({ name, args }) => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: findFirst returns a component (override in specific tests)
    mockPrisma.salaryComponent.findFirst.mockResolvedValue(COMPONENT);
  });

  it('happy path', async () => {
    const res = await call(name, args, { permissions: GRANT });
    expect(res.content).toBeDefined();
    expect(res.content[0].type).toBe('text');
  });

  it('deny-by-default: no permission -> 403', async () => {
    const res = await call(name, args, { permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });

  it('forged isAdmin -> still 403', async () => {
    const res = await call(name, args, { user: { ...USER, isAdmin: true }, permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });
});

describe('DEDUCTION — get edge cases', () => {
  it('404 when not found', async () => {
    mockPrisma.salaryComponent.findFirst.mockResolvedValue(null);
    const res = await call('hr_deduction_get', { id: '999' }, { permissions: GRANT });
    expect(parse(res).status).toBe(404);
  });
});

describe('DEDUCTION — create edge cases', () => {
  it('409 when code exists', async () => {
    mockPrisma.salaryComponent.findFirst.mockResolvedValue({ id: 1 });
    const res = await call('hr_deduction_create', { code: 'TAX-FED', name: 'Tax' }, { permissions: GRANT });
    expect(parse(res).status).toBe(409);
  });
});

describe('DEDUCTION — delete edge cases', () => {
  it('404 when not found', async () => {
    mockPrisma.salaryComponent.findFirst.mockResolvedValue(null);
    const res = await call('hr_deduction_delete', { id: '999' }, { permissions: GRANT });
    expect(parse(res).status).toBe(404);
  });
});

describe('DEDUCTION — unauthenticated', () => {
  it('401 when no user', async () => {
    const res = await mcpCtx.run({}, () => handlers.get('hr_deduction_kpi')({}));
    expect(parse(res).status).toBe(401);
  });
});

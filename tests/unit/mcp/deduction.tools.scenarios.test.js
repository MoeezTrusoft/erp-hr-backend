// tests/unit/mcp/deduction.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR deduction tools (3 tools).
// DB-free: Prisma is mocked; tool→permission gate + dispatch is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  salaryComponent: {
    count: jest.fn(async () => 5),
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
  },
  loan: {
    count: jest.fn(async () => 12),
  },
  payrollDeduction: {
    aggregate: jest.fn(async () => ({ _sum: { amount: 1500 } })),
  },
};

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: mockPrisma,
}));

const { registerDeductionTools } = await import('../../../src/mcp/tools/deductionTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerDeductionTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_deduction_kpi', gate: 'hr:payroll', action: 'VIEW', args: {} },
  { name: 'hr_deduction_list', gate: 'hr:payroll', action: 'VIEW', args: {} },
  { name: 'hr_deduction_get', gate: 'hr:payroll', action: 'VIEW', args: { id: '1' } },
];

describe('DEDUCTION-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches and returns result', async () => {
    if (name === 'hr_deduction_get') {
      mockPrisma.salaryComponent.findFirst.mockResolvedValue({
        id: 1, code: 'TAX-FED', name: 'Federal Tax', type: 'DEDUCTION',
        computation: 'FIXED', formula: null, value: 1500, taxable: true,
        active: true, sortOrder: 0, status: 'PUBLISHED',
        createdAt: new Date(), updatedAt: new Date(),
      });
    }
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

describe('DEDUCTION-SCENARIOS — hr_deduction_get edge cases', () => {
  it('returns 404 when component not found', async () => {
    mockPrisma.salaryComponent.findFirst.mockResolvedValue(null);
    const res = await call('hr_deduction_get', { id: '999' }, { permissions: { 'hr:payroll': ['VIEW'] } });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(404);
  });

  it('returns component data when found', async () => {
    mockPrisma.salaryComponent.findFirst.mockResolvedValue({
      id: 1, code: 'TAX-FED', name: 'Federal Tax', type: 'DEDUCTION',
      computation: 'FIXED', formula: null, value: 1500, taxable: true,
      active: true, sortOrder: 0, status: 'PUBLISHED',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await call('hr_deduction_get', { id: '1' }, { permissions: { 'hr:payroll': ['VIEW'] } });
    const data = parse(res);
    expect(data.code).toBe('TAX-FED');
    expect(data.computation).toBe('FIXED');
    expect(data.value).toBe(1500);
  });
});

describe('DEDUCTION-SCENARIOS — hr_deduction_list edge cases', () => {
  it('returns paginated results', async () => {
    mockPrisma.salaryComponent.findMany.mockResolvedValue([
      { id: 1, code: 'TAX-FED', name: 'Federal Tax', type: 'DEDUCTION', computation: 'FIXED', formula: null, value: 1500, taxable: true, active: true, sortOrder: 0, status: 'PUBLISHED' },
    ]);
    mockPrisma.salaryComponent.count.mockResolvedValue(1);
    const res = await call('hr_deduction_list', { page: 1, pageSize: 10 }, { permissions: { 'hr:payroll': ['VIEW'] } });
    const data = parse(res);
    expect(data.items).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.page).toBe(1);
    expect(data.items[0].formula).toBe('1500');
  });

  it('formats PERCENTAGE computation correctly', async () => {
    mockPrisma.salaryComponent.findMany.mockResolvedValue([
      { id: 2, code: 'TAX-STATE', name: 'State Tax', type: 'DEDUCTION', computation: 'PERCENTAGE', formula: null, value: 7.5, taxable: true, active: true, sortOrder: 0, status: 'PUBLISHED' },
    ]);
    mockPrisma.salaryComponent.count.mockResolvedValue(1);
    const res = await call('hr_deduction_list', {}, { permissions: { 'hr:payroll': ['VIEW'] } });
    const data = parse(res);
    expect(data.items[0].formula).toBe('7.5%');
  });

  it('formats FORMULA computation correctly', async () => {
    mockPrisma.salaryComponent.findMany.mockResolvedValue([
      { id: 3, code: 'DED-HEALTH', name: 'Health Insurance', type: 'DEDUCTION', computation: 'FORMULA', formula: 'base * 0.05', value: null, taxable: false, active: true, sortOrder: 0, status: 'PUBLISHED' },
    ]);
    mockPrisma.salaryComponent.count.mockResolvedValue(1);
    const res = await call('hr_deduction_list', {}, { permissions: { 'hr:payroll': ['VIEW'] } });
    const data = parse(res);
    expect(data.items[0].formula).toBe('base * 0.05');
  });
});

describe('DEDUCTION-SCENARIOS — hr_deduction_kpi', () => {
  it('returns KPI summary with all fields', async () => {
    const res = await call('hr_deduction_kpi', {}, { permissions: { 'hr:payroll': ['VIEW'] } });
    const data = parse(res);
    expect(data).toHaveProperty('activeComponents');
    expect(data).toHaveProperty('activeLoans');
    expect(data).toHaveProperty('taxWithheld');
    expect(data).toHaveProperty('garnishments');
    expect(typeof data.activeComponents).toBe('number');
    expect(typeof data.activeLoans).toBe('number');
  });
});

describe('DEDUCTION-SCENARIOS — unauthenticated', () => {
  it('returns 401 when no user context', async () => {
    const res = await mcpCtx.run({}, () => handlers.get('hr_deduction_kpi')({}));
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(401);
  });
});

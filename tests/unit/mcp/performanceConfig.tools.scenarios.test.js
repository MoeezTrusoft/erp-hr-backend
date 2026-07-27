// tests/unit/mcp/performanceConfig.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR performance config tools (13 tools: cycle + template + metric).
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/performanceCycleService.js', () => ({
  createPerformanceCycle: jest.fn(async () => ({ success: true })),
  getAllPerformanceCycles: jest.fn(async () => ({ success: true })),
  getPerformanceCycleById: jest.fn(async () => ({ success: true })),
  updatePerformanceCycle: jest.fn(async () => ({ success: true })),
  deletePerformanceCycle: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/services/performanceTemplateService.js', () => ({
  createPerformanceTemplate: jest.fn(async () => ({ success: true })),
  getAllPerformanceTemplates: jest.fn(async () => ({ success: true })),
  getPerformanceTemplateById: jest.fn(async () => ({ success: true })),
  updatePerformanceTemplate: jest.fn(async () => ({ success: true })),
  deletePerformanceTemplate: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/services/performanceMetricService.js', () => ({
  createMetric: jest.fn(async () => ({ success: true })),
  listMetrics: jest.fn(async () => ({ success: true })),
  deactivateMetric: jest.fn(async () => ({ success: true })),
}));

const { registerPerformanceConfigTools } = await import('../../../src/mcp/tools/performanceConfigTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerPerformanceConfigTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_performance_cycle_list', gate: 'hr:performance', action: 'VIEW', args: {} },
  { name: 'hr_performance_cycle_get', gate: 'hr:performance', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_performance_cycle_create', gate: 'hr:performance', action: 'CREATE', args: { name: 'Q1 2026', startDate: '2026-01-01', endDate: '2026-03-31' } },
  { name: 'hr_performance_cycle_update', gate: 'hr:performance', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_performance_cycle_delete', gate: 'hr:performance', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_performance_template_list', gate: 'hr:performance', action: 'VIEW', args: {} },
  { name: 'hr_performance_template_get', gate: 'hr:performance', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_performance_template_create', gate: 'hr:performance', action: 'CREATE', args: { name: 'Standard Review' } },
  { name: 'hr_performance_template_update', gate: 'hr:performance', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_performance_template_delete', gate: 'hr:performance', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_performance_metric_list', gate: 'hr:performance', action: 'VIEW', args: {} },
  { name: 'hr_performance_metric_create', gate: 'hr:performance', action: 'CREATE', args: { name: 'Code Quality' } },
  { name: 'hr_performance_metric_deactivate', gate: 'hr:performance', action: 'DELETE', args: { id: '1' } },
];

describe('PERFORMANCE-CONFIG-SCENARIOS — registration', () => {
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

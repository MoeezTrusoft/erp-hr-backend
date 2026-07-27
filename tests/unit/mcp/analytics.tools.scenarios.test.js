// tests/unit/mcp/analytics.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR analytics tools (1 tool). DB-free: controller is mocked; tool→controller dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/mcp/controllers/analyticsMcpController.js', () => ({
  mcpExportAnalyticsReport: jest.fn(async () => ({ success: true })),
  mcpGetAnalyticsAbsence: jest.fn(async () => ({ success: true })),
  mcpGetAnalyticsDashboardOverview: jest.fn(async () => ({ success: true })),
  mcpGetAnalyticsDashboardPerformance: jest.fn(async () => ({ success: true })),
  mcpGetAnalyticsDashboardRecruitment: jest.fn(async () => ({ success: true })),
  mcpGetAnalyticsEeo: jest.fn(async () => ({ success: true })),
  mcpGetAnalyticsHeadcount: jest.fn(async () => ({ success: true })),
  mcpGetAnalyticsLeaveBalances: jest.fn(async () => ({ success: true })),
  mcpGetAnalyticsRecruitmentPipeline: jest.fn(async () => ({ success: true })),
  mcpGetAnalyticsSalary: jest.fn(async () => ({ success: true })),
  mcpGetAnalyticsTurnover: jest.fn(async () => ({ success: true })),
}));

const { registerAnalyticsTools } = await import('../../../src/mcp/tools/analyticsTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerAnalyticsTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_analytics_export_report', gate: 'hr:analytics', action: 'CREATE', args: { reportType: 'headcount' } },
];

describe('ANALYTICS-SCENARIOS — registration', () => {
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
    const body = parse(res);
    expect(body.success).toBe(true);
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

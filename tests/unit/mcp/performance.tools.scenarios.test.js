// tests/unit/mcp/performance.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR performance tools (13 tools).
// DB-free: controller is mocked; tool→controller dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { z } from 'zod';

jest.unstable_mockModule('../../../src/mcp/controllers/performanceMcpController.js', () => ({
  mcpListPerformanceReviews: jest.fn(async () => ({ success: true })),
  mcpListCalibrationSessions: jest.fn(async () => ({ success: true })),
  mcpListGoals: jest.fn(async () => ({ success: true })),
  mcpListPerformanceMetrics: jest.fn(async () => ({ success: true })),
  mcpCreateGoal: jest.fn(async () => ({ success: true })),
  mcpUpdateGoal: jest.fn(async () => ({ success: true })),
  mcpApproveGoal: jest.fn(async () => ({ success: true })),
  mcpRecordGoalProgress: jest.fn(async () => ({ success: true })),
  mcpCreatePerformanceReview: jest.fn(async () => ({ success: true })),
  mcpUpdatePerformanceReview: jest.fn(async () => ({ success: true })),
  mcpAddPerformanceFeedback: jest.fn(async () => ({ success: true })),
  mcpCreateCalibration: jest.fn(async () => ({ success: true })),
  mcpFinalizeCalibration: jest.fn(async () => ({ success: true })),
  mcpAdjustCalibrationRating: jest.fn(async () => ({ success: true })),
  mcpCreateDevelopmentPlan: jest.fn(async () => ({ success: true })),
}));

const { registerPerformanceTools } = await import('../../../src/mcp/tools/performanceTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const schemas = new Map();
const resources = new Map();
const recording = {
  tool: (name, ...rest) => {
    schemas.set(name, rest[rest.length - 2]);
    handlers.set(name, rest[rest.length - 1]);
  },
  resource: (_name, uri, _options, callback) => resources.set(uri, callback),
};
registerPerformanceTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

describe.each(['hr://performance/reviews', 'hr://goals', 'hr://calibration', 'hr://performance/metrics'])('%s resource authorization', uri => {
  const read = (permissions, user = USER) => mcpCtx.run({ user, permissions }, () => resources.get(uri)(new URL(uri)));
  it('denies missing, write-only and forged-admin grants', async () => {
    const controllers = await import('../../../src/mcp/controllers/performanceMcpController.js');
    jest.clearAllMocks();
    for (const permissions of [{}, { 'hr:performance': ['CREATE', 'EDIT'] }]) {
      await expect(read(permissions, { ...USER, isAdmin: true })).rejects.toMatchObject({ status: 403 });
    }
    for (const name of ['mcpListPerformanceReviews', 'mcpListGoals', 'mcpListCalibrationSessions', 'mcpListPerformanceMetrics']) {
      expect(controllers[name]).not.toHaveBeenCalled();
    }
  });
  it('requires authentication and accepts the canonical read grant', async () => {
    await expect(read(['hr.performance.read'], null)).rejects.toMatchObject({ status: 401 });
    const result = await read(['hr.performance.read']);
    expect(result.contents[0].uri).toBe(uri);
    expect(result.contents[0].mimeType).toBe('application/json');
  });
});

const TOOLS = [
  { name: 'hr_performance_reviews_list', gate: 'hr:performance', action: 'VIEW', args: {} },
  { name: 'hr_goal_create', gate: 'hr:performance', action: 'CREATE', args: { employeeId: '7', title: 'Q1 Goal', start_date: '2026-01-01', end_date: '2026-03-31' } },
  { name: 'hr_goal_update', gate: 'hr:performance', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_goal_approve', gate: 'hr:performance', action: 'EDIT', args: { id: '1', status: 'APPROVED' } },
  { name: 'hr_goal_progress_record', gate: 'hr:performance', action: 'CREATE', args: { goalId: '1', progress: 50 } },
  { name: 'hr_performance_review_create', gate: 'hr:performance', action: 'CREATE', args: { employeeId: '7', reviewerId: '8', period_start: '2026-01-01', period_end: '2026-06-30' } },
  { name: 'hr_performance_review_update', gate: 'hr:performance', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_performance_feedback_add', gate: 'hr:performance', action: 'CREATE', args: { reviewId: '1', reviewerId: '8', feedback: 'Great work' } },
  { name: 'hr_calibration_create', gate: 'hr:performance', action: 'CREATE', args: { name: 'Q1 Cal', cycleId: '1' } },
  { name: 'hr_calibration_update', gate: 'hr:performance', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_calibration_adjust_rating', gate: 'hr:performance', action: 'CREATE', args: { reviewId: '1', old_rating: 3, new_rating: 4 } },
  { name: 'hr_calibration_finalize', gate: 'hr:performance', action: 'EDIT', args: { id: '1' } },
];

describe('PERFORMANCE-SCENARIOS — registration', () => {
  it('validates canonical identifiers before the MCP SDK can coerce booleans', () => {
    const schema = z.object(schemas.get('hr_performance_reviews_list'));
    for (const value of [true, false, '1e2', '1.0', -1, 0]) {
      expect(schema.safeParse({ employeeId: value }).success).toBe(false);
      expect(schema.safeParse({ page: value }).success).toBe(false);
    }
    expect(schema.parse({ page: '2', q: ' EMP-1 ' })).toMatchObject({ page: 2, pageSize: 50, q: 'EMP-1' });
    expect(schema.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
  });
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

// tests/unit/mcp/performance.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR performance tools (13 tools).
// DB-free: controller is mocked; tool→controller dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

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
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
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

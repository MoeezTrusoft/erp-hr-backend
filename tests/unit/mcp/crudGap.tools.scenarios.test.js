// tests/unit/mcp/crudGap.tools.scenarios.test.js
//
// Per-tool scenario matrix for all remaining CRUD gap tools (17 new).
// DB-free: prisma/services are mocked; tool→dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Mocks ──────────────────────────────────────────────────────────────────
const applicationDelete = jest.fn(async () => ({}));
const applicationFindUnique = jest.fn(async () => ({ id: 1 }));
const leaveBalanceDelete = jest.fn(async () => ({}));
const lifecycleEventUpdate = jest.fn(async () => ({ id: 1 }));
const lifecycleEventDelete = jest.fn(async () => ({}));
const devPlanCreate = jest.fn(async () => ({ id: 1 }));
const devPlanItemCreate = jest.fn(async () => ({ id: 1 }));
const courseOutcomeFindMany = jest.fn(async () => []);
const courseOutcomeFindUnique = jest.fn(async () => ({ id: 1 }));
const courseOutcomeUpdate = jest.fn(async () => ({ id: 1 }));
const courseReviewFindMany = jest.fn(async () => []);
const courseReviewFindUnique = jest.fn(async () => ({ id: 1 }));
const courseReviewUpdate = jest.fn(async () => ({ id: 1 }));
const courseReviewDelete = jest.fn(async () => ({}));

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: {
    application: { delete: applicationDelete, findUnique: applicationFindUnique },
    leaveBalance: { delete: leaveBalanceDelete },
    employeeLifecycleEvent: { update: lifecycleEventUpdate, delete: lifecycleEventDelete },
    developmentPlan: { create: devPlanCreate },
    developmentPlanItem: { create: devPlanItemCreate },
    courseOutcome: { findMany: courseOutcomeFindMany, findUnique: courseOutcomeFindUnique, update: courseOutcomeUpdate },
    courseReview: { findMany: courseReviewFindMany, findUnique: courseReviewFindUnique, update: courseReviewUpdate, delete: courseReviewDelete },
  },
}));

jest.unstable_mockModule('../../../src/services/developmentPlan.service.js', () => ({
  createPlan: jest.fn(async () => ({ id: 1 })),
  listPlans: jest.fn(async () => []),
  addPlanItem: jest.fn(async () => ({ id: 1 })),
  listPlanItems: jest.fn(async () => []),
  updatePlanItem: jest.fn(async () => ({ id: 1 })),
}));

// ── Register tools ─────────────────────────────────────────────────────────
const { registerApplicationTools } = await import('../../../src/mcp/tools/applicationTools.js');
const { registerLeaveTools } = await import('../../../src/mcp/tools/leaveTools.js');
const { registerLifecycleComplianceTools } = await import('../../../src/mcp/tools/lifecycleComplianceTools.js');
const { registerDevelopmentPlanTools } = await import('../../../src/mcp/tools/developmentPlanTools.js');
const { registerCatalogTools } = await import('../../../src/mcp/tools/catalogTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerApplicationTools(recording);
registerLeaveTools(recording);
registerLifecycleComplianceTools(recording);
registerDevelopmentPlanTools(recording);
registerCatalogTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  // Application
  { name: 'hr_application_delete', gate: 'hr:recruitment', action: 'DELETE', args: { id: '1' } },
  // LeaveBalance
  { name: 'hr_leave_balance_delete', gate: 'hr:leave', action: 'DELETE', args: { employeeId: '7', leavePolicyId: '1' } },
  // LifecycleEvent
  { name: 'hr_lifecycle_event_update', gate: 'hr:employee', action: 'PUT', args: { id: '1' } },
  { name: 'hr_lifecycle_event_delete', gate: 'hr:employee', action: 'DELETE', args: { id: '1' } },
  // DevelopmentPlan
  { name: 'hr_development_plan_create', gate: 'hr:performance', action: 'POST', args: { employeeId: '7', title: 'Test Plan' } },
  { name: 'hr_development_plan_item_create', gate: 'hr:performance', action: 'POST', args: { planId: '1', title: 'Test Item' } },
  // CourseOutcome
  { name: 'hr_course_outcome_list', gate: 'hr:learning', action: 'GET', args: { courseId: 1 } },
  { name: 'hr_course_outcome_get', gate: 'hr:learning', action: 'GET', args: { id: 1 } },
  { name: 'hr_course_outcome_update', gate: 'hr:learning', action: 'PUT', args: { id: 1 } },
  // CourseReview
  { name: 'hr_course_review_list', gate: 'hr:learning', action: 'GET', args: { courseId: 1 } },
  { name: 'hr_course_review_get', gate: 'hr:learning', action: 'GET', args: { id: 1 } },
  { name: 'hr_course_review_update', gate: 'hr:learning', action: 'PUT', args: { id: 1 } },
  { name: 'hr_course_review_delete', gate: 'hr:learning', action: 'DELETE', args: { id: 1 } },
];

describe('CRUD-GAP-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to prisma/service and returns result', async () => {
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

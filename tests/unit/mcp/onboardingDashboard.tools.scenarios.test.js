// tests/unit/mcp/onboardingDashboard.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR onboarding dashboard/schedule/portal-screen tools (17 tools).
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// --- Mocks ---
jest.unstable_mockModule('../../../src/services/onboardingDashboard.service.js', () => ({
  getOnboardingDashboard: jest.fn(async () => ({ success: true })),
  addNewHire: jest.fn(async () => ({ success: true })),
  getOnboardingExportRows: jest.fn(async () => []),
  getQuickProgress: jest.fn(async () => ({ progress: 50 })),
  EXPORT_COLUMNS: [],
}));
jest.unstable_mockModule('../../../src/middlewares/idempotency.middleware.js', () => ({
  runMcpIdempotent: jest.fn(async ({ run }) => ({ value: await run() })),
}));
jest.unstable_mockModule('../../../src/lib/export.util.js', () => ({
  exportRows: jest.fn(async () => ({ ext: 'csv', mimeType: 'text/csv', buffer: Buffer.from('') })),
}));
jest.unstable_mockModule('../../../src/services/onboardingSchedule.service.js', () => ({
  listSchedule: jest.fn(async () => ({ success: true })),
  createSession: jest.fn(async () => ({ success: true })),
  updateSession: jest.fn(async () => ({ success: true })),
  listDocuments: jest.fn(async () => ({ success: true })),
  addDocument: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/services/onboardingPortalScreen.service.js', () => ({
  getOnboardingPortal: jest.fn(async () => ({ success: true })),
  createPortalTask: jest.fn(async () => ({ success: true })),
  updatePortalTask: jest.fn(async () => ({ success: true })),
  completePortalTask: jest.fn(async () => ({ success: true })),
  deletePortalTask: jest.fn(async () => ({ success: true })),
  getFeedbackQuestions: jest.fn(async () => ({ success: true })),
  submitPortalFeedback: jest.fn(async () => ({ success: true })),
  sendTaskReminder: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/lib/onboardingTaxonomy.js', () => ({
  ONBOARDING_TASK_CATEGORIES: ['IT_SETUP', 'WORKSPACE', 'DOCUMENTS', 'TRAINING', 'SOCIAL', 'OTHER'],
}));

// --- Imports ---
const { registerOnboardingDashboardTools } = await import('../../../src/mcp/tools/onboardingDashboardTools.js');
const { registerOnboardingScheduleTools } = await import('../../../src/mcp/tools/onboardingScheduleTools.js');
const { registerOnboardingPortalScreenTools } = await import('../../../src/mcp/tools/onboardingPortalScreenTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerOnboardingDashboardTools(recording);
registerOnboardingScheduleTools(recording);
registerOnboardingPortalScreenTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  // --- onboardingDashboardTools.js (4 tools) ---
  { name: 'hr_onboarding_dashboard_get', gate: 'hr:onboarding', action: 'VIEW', args: {} },
  { name: 'hr_onboarding_add_new_hire', gate: 'hr:onboarding', action: 'CREATE', args: { employeeId: '7', startDate: '2026-08-01' } },
  { name: 'hr_onboarding_export', gate: 'hr:onboarding', action: 'VIEW', args: { format: 'csv' } },
  { name: 'hr_onboarding_quick_progress', gate: 'hr:onboarding', action: 'VIEW', args: { id: '1' } },
  // --- onboardingScheduleTools.js (5 tools) ---
  { name: 'hr_onboarding_schedule_list', gate: 'hr:onboarding', action: 'VIEW', args: { checklistId: '1' } },
  { name: 'hr_onboarding_schedule_create', gate: 'hr:onboarding', action: 'CREATE', args: { checklistId: '1', title: 'Day 1' } },
  { name: 'hr_onboarding_schedule_update', gate: 'hr:onboarding', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_onboarding_documents_list', gate: 'hr:onboarding', action: 'VIEW', args: { checklistId: '1' } },
  { name: 'hr_onboarding_document_add', gate: 'hr:onboarding', action: 'CREATE', args: { checklistId: '1', employeeId: '7', title: 'NDA', mediaId: '10' } },
  // --- onboardingPortalScreenTools.js (8 tools) ---
  { name: 'hr_onboarding_portal_get', gate: 'hr:onboarding', action: 'VIEW', args: {} },
  { name: 'hr_onboarding_portal_task_create', gate: 'hr:onboarding', action: 'CREATE', args: { title: 'Setup workstation' } },
  { name: 'hr_onboarding_portal_task_update', gate: 'hr:onboarding', action: 'EDIT', args: { taskId: '1' } },
  { name: 'hr_onboarding_portal_task_complete', gate: 'hr:onboarding', action: 'EDIT', args: { taskId: '1' } },
  { name: 'hr_onboarding_portal_task_delete', gate: 'hr:onboarding', action: 'DELETE', args: { taskId: '1' } },
  { name: 'hr_onboarding_portal_feedback_questions', gate: 'hr:onboarding', action: 'VIEW', args: {} },
  { name: 'hr_onboarding_portal_feedback_submit', gate: 'hr:onboarding', action: 'CREATE', args: { answers: [{ questionId: 'q1', value: 5 }] } },
  { name: 'hr_onboarding_portal_send_reminder', gate: 'hr:onboarding', action: 'CREATE', args: { taskId: '1' } },
];

describe('ONBOARDING-DASHBOARD-SCENARIOS — registration', () => {
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

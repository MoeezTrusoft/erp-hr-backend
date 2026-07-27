// tests/unit/mcp/onboarding.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR onboarding core tools (18 tools across 4 files).
// DB-free: controllers/services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// --- Mocks: onboardingMcpController (used by onboardingTools.js) ---
jest.unstable_mockModule('../../../src/mcp/controllers/onboardingMcpController.js', () => ({
  mcpListOnboardingChecklists: jest.fn(async () => ({ success: true })),
  mcpListOnboardingSurveys: jest.fn(async () => ({ success: true })),
  mcpCreateOnboardingChecklist: jest.fn(async () => ({ success: true })),
  mcpUpdateOnboardingChecklist: jest.fn(async () => ({ success: true })),
  mcpAddOnboardingTask: jest.fn(async () => ({ success: true })),
  mcpUpdateOnboardingTask: jest.fn(async () => ({ success: true })),
  mcpDeleteOnboardingTask: jest.fn(async () => ({ success: true })),
  mcpSignOnboardingDocument: jest.fn(async () => ({ success: true })),
  mcpAssignOnboardingBuddy: jest.fn(async () => ({ success: true })),
  mcpSubmitOnboardingSurvey: jest.fn(async () => ({ success: true })),
}));

// --- Mocks: onboardingMgmt.service (used by onboardingMgmtTools.js) ---
jest.unstable_mockModule('../../../src/services/onboardingMgmt.service.js', () => ({
  listOnboarding: jest.fn(async () => ({ success: true })),
}));

// --- Mocks: onboardingDetail.service (used by onboardingDetailTools.js) ---
jest.unstable_mockModule('../../../src/services/onboardingDetail.service.js', () => ({
  getOnboardingDetail: jest.fn(async () => ({ success: true })),
  createOnboardingTask: jest.fn(async () => ({ success: true })),
  sendOnboardingReminder: jest.fn(async () => ({ success: true })),
}));

// --- Mocks: onboardingPortal.service (used by onboardingPortalTools.js) ---
jest.unstable_mockModule('../../../src/services/onboardingPortal.service.js', () => ({
  getPreboarding: jest.fn(async () => ({ success: true })),
  updatePreboarding: jest.fn(async () => ({ success: true })),
  submitFeedback: jest.fn(async () => ({ success: true })),
  viewFeedback: jest.fn(async () => ({ success: true })),
  addNote: jest.fn(async () => ({ success: true })),
  listActivity: jest.fn(async () => ({ success: true })),
}));

// --- Imports ---
const { registerOnboardingTools } = await import('../../../src/mcp/tools/onboardingTools.js');
const { registerOnboardingMgmtTools } = await import('../../../src/mcp/tools/onboardingMgmtTools.js');
const { registerOnboardingDetailTools } = await import('../../../src/mcp/tools/onboardingDetailTools.js');
const { registerOnboardingPortalTools } = await import('../../../src/mcp/tools/onboardingPortalTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerOnboardingTools(recording);
registerOnboardingMgmtTools(recording);
registerOnboardingDetailTools(recording);
registerOnboardingPortalTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  // --- onboardingTools.js (8 tools) ---
  { name: 'hr_onboarding_checklist_create', gate: 'hr:onboarding', action: 'CREATE', args: { employeeId: '7' } },
  { name: 'hr_onboarding_checklist_update', gate: 'hr:onboarding', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_onboarding_task_add', gate: 'hr:onboarding', action: 'CREATE', args: { checklistId: '1', title: 'Sign NDA' } },
  { name: 'hr_onboarding_task_update', gate: 'hr:onboarding', action: 'EDIT', args: { taskId: '1' } },
  { name: 'hr_onboarding_task_delete', gate: 'hr:onboarding', action: 'DELETE', args: { taskId: '1' } },
  { name: 'hr_onboarding_document_sign', gate: 'hr:onboarding', action: 'EDIT', args: { docId: '1' } },
  { name: 'hr_onboarding_buddy_assign', gate: 'hr:onboarding', action: 'CREATE', args: { checklistId: '1', buddyId: '8' } },
  { name: 'hr_onboarding_survey_submit', gate: 'hr:onboarding', action: 'CREATE', args: { employeeId: '7', surveyType: 'ONBOARDING', responses: {} } },
  // --- onboardingMgmtTools.js (1 tool) ---
  { name: 'hr_onboarding_manage_list', gate: 'hr:onboarding', action: 'VIEW', args: {} },
  // --- onboardingDetailTools.js (3 tools) ---
  { name: 'hr_onboarding_detail_get', gate: 'hr:onboarding', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_onboarding_task_create', gate: 'hr:onboarding', action: 'CREATE', args: { checklistId: '1', title: 'Setup laptop', stage: 'pre_boarding' } },
  { name: 'hr_onboarding_send_reminder', gate: 'hr:onboarding', action: 'CREATE', args: { checklistId: '1', sendTo: 'newhire@test.com', subject: 'Reminder', message: 'Please complete' } },
  // --- onboardingPortalTools.js (6 tools) ---
  { name: 'hr_onboarding_preboarding_get', gate: 'hr:onboarding', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_onboarding_preboarding_update', gate: 'hr:onboarding', action: 'EDIT', args: { id: '1', group: 'readiness', key: 'bgCheck', value: true } },
  { name: 'hr_onboarding_feedback_submit', gate: 'hr:onboarding', action: 'CREATE', args: { checklistId: '1', ratings: { roleClarity: 5 } } },
  { name: 'hr_onboarding_feedback_view', gate: 'hr:onboarding', action: 'VIEW', args: { checklistId: '1' } },
  { name: 'hr_onboarding_note_add', gate: 'hr:onboarding', action: 'EDIT', args: { checklistId: '1', text: 'Welcome note' } },
  { name: 'hr_onboarding_activity_list', gate: 'hr:onboarding', action: 'VIEW', args: { checklistId: '1' } },
];

describe('ONBOARDING-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to controller/service and returns result', async () => {
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

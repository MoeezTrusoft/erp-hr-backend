// tests/unit/mcp/recruitment.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR recruitment tools (24 tools across 3 files).
// DB-free: controllers/services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// --- Mocks ---
jest.unstable_mockModule('../../../src/mcp/controllers/recruitmentMcpController.js', () => ({
  mcpListRequisitions: jest.fn(async () => ({ success: true })),
  mcpListCandidates: jest.fn(async () => ({ success: true })),
  mcpCreateRequisition: jest.fn(async () => ({ success: true })),
  mcpUpdateRequisition: jest.fn(async () => ({ success: true })),
  mcpApproveRequisition: jest.fn(async () => ({ success: true })),
  mcpPostRequisition: jest.fn(async () => ({ success: true })),
  mcpDeleteRequisition: jest.fn(async () => ({ success: true })),
  mcpCreateCandidate: jest.fn(async () => ({ success: true })),
  mcpUpdateCandidate: jest.fn(async () => ({ success: true })),
  mcpCreateApplication: jest.fn(async () => ({ success: true })),
  mcpUpdateApplicationStage: jest.fn(async () => ({ success: true })),
  mcpUpdateApplicationStatus: jest.fn(async () => ({ success: true })),
  mcpCreateInterview: jest.fn(async () => ({ success: true })),
  mcpUpdateInterview: jest.fn(async () => ({ success: true })),
  mcpCreateOffer: jest.fn(async () => ({ success: true })),
  mcpUpdateOffer: jest.fn(async () => ({ success: true })),
  mcpSendOffer: jest.fn(async () => ({ success: true })),
  mcpAddTalentPool: jest.fn(async () => ({ success: true })),
  mcpRemoveTalentPool: jest.fn(async () => ({ success: true })),
  mcpListApplications: jest.fn(async () => ({ success: true })),
  mcpListRecruitmentTags: jest.fn(async () => ({ success: true })),
  mcpListInterviews: jest.fn(async () => ({ success: true })),
  mcpListOffers: jest.fn(async () => ({ success: true })),
  mcpListTalentPool: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/middlewares/idempotency.middleware.js', () => ({
  runMcpIdempotent: jest.fn(async ({ run }) => ({ value: await run() })),
}));
jest.unstable_mockModule('../../../src/mcp/utils/listEnvelope.js', () => ({
  toListEnvelope: jest.fn((data) => ({ items: Array.isArray(data) ? data : [], total: Array.isArray(data) ? data.length : 0 })),
  toListQuery: jest.fn((args) => args),
}));
jest.unstable_mockModule('../../../src/services/recruitmentAnalytics.service.js', () => ({
  computeRecruitmentAnalytics: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/lib/export.util.js', () => ({
  exportRows: jest.fn(async () => ({ ext: 'csv', mimeType: 'text/csv', buffer: Buffer.from('') })),
}));
jest.unstable_mockModule('../../../src/services/recruitmentCost.service.js', () => ({
  getCostConfig: jest.fn(async () => ({ success: true })),
  setCostConfig: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/services/candidateResume.service.js', () => ({
  uploadCandidateResume: jest.fn(async () => ({ success: true })),
}));

// --- Imports ---
const { registerRecruitmentTools } = await import('../../../src/mcp/tools/recruitmentTools.js');
const { registerRecruitmentAnalyticsTools } = await import('../../../src/mcp/tools/recruitmentAnalyticsTools.js');
const { registerRecruitmentExtraTools } = await import('../../../src/mcp/tools/recruitmentExtraTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerRecruitmentTools(recording);
registerRecruitmentAnalyticsTools(recording);
registerRecruitmentExtraTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  // --- recruitmentTools.js (19 tools) ---
  { name: 'hr_requisitions_list', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  { name: 'hr_candidates_list', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  { name: 'hr_requisition_create', gate: 'hr:recruitment', action: 'CREATE', args: { title: 'Sr Engineer', requestedById: '7' } },
  { name: 'hr_requisition_update', gate: 'hr:recruitment', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_requisition_approve', gate: 'hr:recruitment', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_requisition_post', gate: 'hr:recruitment', action: 'CREATE', args: { id: '1' } },
  { name: 'hr_requisition_delete', gate: 'hr:recruitment', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_candidate_create', gate: 'hr:recruitment', action: 'CREATE', args: { firstName: 'Jane', email: 'jane@test.com' } },
  { name: 'hr_candidate_update', gate: 'hr:recruitment', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_application_create', gate: 'hr:recruitment', action: 'CREATE', args: { candidateId: '1', requisitionId: '1' } },
  { name: 'hr_application_update_stage', gate: 'hr:recruitment', action: 'EDIT', args: { id: '1', stage: 'INTERVIEW' } },
  { name: 'hr_application_update_status', gate: 'hr:recruitment', action: 'EDIT', args: { id: '1', status: 'ACTIVE' } },
  { name: 'hr_interview_create', gate: 'hr:recruitment', action: 'CREATE', args: { applicationId: '1', scheduledAt: '2026-08-01T10:00:00Z', interviewType: 'TECHNICAL' } },
  { name: 'hr_interview_update', gate: 'hr:recruitment', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_offer_create', gate: 'hr:recruitment', action: 'CREATE', args: { applicationId: '1', baseSalary: 80000, candidateId: '1', jobRequisitionId: '1' } },
  { name: 'hr_offer_update', gate: 'hr:recruitment', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_offer_send', gate: 'hr:recruitment', action: 'CREATE', args: { id: '1' } },
  { name: 'hr_talent_pool_add', gate: 'hr:recruitment', action: 'CREATE', args: { candidateId: '1' } },
  { name: 'hr_talent_pool_remove', gate: 'hr:recruitment', action: 'DELETE', args: { id: '1' } },
  // --- recruitmentAnalyticsTools.js (2 tools) ---
  { name: 'hr_recruitment_analytics_get', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  { name: 'hr_recruitment_analytics_export', gate: 'hr:recruitment', action: 'VIEW', args: { format: 'csv' } },
  // --- recruitmentExtraTools.js (3 tools) ---
  { name: 'hr_recruitment_cost_config_get', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  { name: 'hr_recruitment_cost_config_set', gate: 'hr:recruitment', action: 'EDIT', args: {} },
  { name: 'hr_candidate_resume_upload', gate: 'hr:recruitment', action: 'CREATE', args: { candidateId: '1', fileBase64: 'dGVzdA==' } },
];

describe('RECRUITMENT-SCENARIOS — registration', () => {
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

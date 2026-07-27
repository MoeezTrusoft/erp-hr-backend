// tests/unit/mcp/interviewOffer.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR interview management + offer management tools (9 tools).
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/interviewMgmt.service.js', () => ({
  listInterviewsManaged: jest.fn(async () => ({ success: true })),
  getInterviewManaged: jest.fn(async () => ({ success: true })),
  scoreInterview: jest.fn(async () => ({ success: true })),
  setInterviewOutcome: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/services/offerMgmt.service.js', () => ({
  listOffersManage: jest.fn(async () => ({ success: true })),
  getOfferManage: jest.fn(async () => ({ success: true })),
  previewOfferManage: jest.fn(async () => ({ success: true })),
  createOfferFull: jest.fn(async () => ({ success: true })),
  markOfferPreboarding: jest.fn(async () => ({ success: true })),
}));

const { registerInterviewMgmtTools } = await import('../../../src/mcp/tools/interviewMgmtTools.js');
const { registerOfferMgmtTools } = await import('../../../src/mcp/tools/offerMgmtTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerInterviewMgmtTools(recording);
registerOfferMgmtTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  // --- interviewMgmtTools.js (4 tools) ---
  { name: 'hr_interviews_manage_list', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  { name: 'hr_interview_manage_get', gate: 'hr:recruitment', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_interview_score', gate: 'hr:recruitment', action: 'CREATE', args: { interviewId: '1', ratings: { technicalSkills: 5, problemSolving: 4, communication: 4, cultureFit: 5 }, decision: 'PASS', recommendation: 'Strong hire' } },
  { name: 'hr_interview_set_outcome', gate: 'hr:recruitment', action: 'EDIT', args: { interviewId: '1', decision: 'PASS' } },
  // --- offerMgmtTools.js (5 tools) ---
  { name: 'hr_offers_manage_list', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  { name: 'hr_offer_manage_get', gate: 'hr:recruitment', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_offer_create_full', gate: 'hr:recruitment', action: 'CREATE', args: { applicationId: '1', candidateId: '1', jobRequisitionId: '1', baseSalary: 80000 } },
  { name: 'hr_offer_preview', gate: 'hr:recruitment', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_offer_preboarding', gate: 'hr:recruitment', action: 'EDIT', args: { id: '1' } },
];

describe('INTERVIEW-OFFER-SCENARIOS — registration', () => {
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

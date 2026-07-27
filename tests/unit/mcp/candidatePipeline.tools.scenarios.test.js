// tests/unit/mcp/candidatePipeline.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR candidate pipeline + resume + talent pool mgmt tools (9 tools).
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/candidatePipeline.service.js', () => ({
  getPipelineBoard: jest.fn(async () => ({ success: true })),
  listPipelineCards: jest.fn(async () => ({ success: true })),
  PIPELINE_STAGES: ['NEW', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'],
}));
jest.unstable_mockModule('../../../src/utils/apiContract.js', () => ({
  buildListPayload: jest.fn(({ items, page, pageSize, total, sort, order, filters }) => ({ items, page, pageSize, total, sort, order, filters })),
}));
jest.unstable_mockModule('../../../src/services/resumeParsing.service.js', () => ({
  parseResumePreview: jest.fn(async () => ({ success: true })),
  ingestEmployeeResume: jest.fn(async () => ({ success: true })),
  ingestCandidateResume: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/lib/employeeActor.js', () => ({
  requireEmployeeActor: jest.fn(() => ({ employeeId: '7' })),
}));
jest.unstable_mockModule('../../../src/services/talentPoolMgmt.service.js', () => ({
  listManagedPool: jest.fn(async () => ({ success: true })),
  getPoolProfile: jest.fn(async () => ({ success: true })),
  moveToPipeline: jest.fn(async () => ({ success: true })),
  inviteCandidate: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/mcp/utils/listEnvelope.js', () => ({
  toListEnvelope: jest.fn((data) => ({ items: Array.isArray(data) ? data : [], total: Array.isArray(data) ? data.length : 0 })),
  toListQuery: jest.fn((args) => args),
}));

const { registerCandidatePipelineTools } = await import('../../../src/mcp/tools/candidatePipelineTools.js');
const { registerResumeTools } = await import('../../../src/mcp/tools/resumeTools.js');
const { registerTalentPoolMgmtTools } = await import('../../../src/mcp/tools/talentPoolMgmtTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerCandidatePipelineTools(recording);
registerResumeTools(recording);
registerTalentPoolMgmtTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  // --- candidatePipelineTools.js (2 tools) ---
  { name: 'hr_candidate_pipeline_get', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  { name: 'hr_candidate_pipeline_list', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  // --- resumeTools.js (3 tools) ---
  { name: 'hr_resume_parse_preview', gate: 'hr:employee', action: 'VIEW', args: { resumeMediaId: '10' } },
  { name: 'hr_resume_employee_ingest', gate: 'hr:employee', action: 'CREATE', args: { employeeId: '7', resumeMediaId: '10' } },
  { name: 'hr_resume_candidate_ingest', gate: 'hr:recruitment', action: 'CREATE', args: { candidateId: '1' } },
  // --- talentPoolMgmtTools.js (4 tools) ---
  { name: 'hr_talent_pool_manage_list', gate: 'hr:recruitment', action: 'VIEW', args: {} },
  { name: 'hr_talent_pool_profile_get', gate: 'hr:recruitment', action: 'VIEW', args: { candidateId: '1' } },
  { name: 'hr_talent_pool_move_to_pipeline', gate: 'hr:recruitment', action: 'CREATE', args: { candidateId: '1', jobRequisitionId: '1' } },
  { name: 'hr_talent_pool_invite', gate: 'hr:recruitment', action: 'EDIT', args: { candidateId: '1' } },
];

describe('CANDIDATE-PIPELINE-SCENARIOS — registration', () => {
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

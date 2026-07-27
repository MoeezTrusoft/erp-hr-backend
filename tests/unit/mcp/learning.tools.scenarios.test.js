// tests/unit/mcp/learning.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR learning & certification tools (17 tools).
// DB-free: controller is mocked; tool→controller dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/mcp/controllers/learningMcpController.js', () => ({
  mcpBulkTrainingEnrollment: jest.fn(async () => ({ success: true })),
  mcpCancelTrainingEnrollment: jest.fn(async () => ({ success: true })),
  mcpCreateCertification: jest.fn(async () => ({ success: true })),
  mcpCreateLearningPath: jest.fn(async () => ({ success: true })),
  mcpCreateTrainingCategory: jest.fn(async () => ({ success: true })),
  mcpCreateTrainingCourse: jest.fn(async () => ({ success: true })),
  mcpCreateTrainingEnrollment: jest.fn(async () => ({ success: true })),
  mcpDeleteCertification: jest.fn(async () => ({ success: true })),
  mcpDeleteTrainingCourse: jest.fn(async () => ({ success: true })),
  mcpGetCertification: jest.fn(async () => ({ success: true })),
  mcpListCertifications: jest.fn(async () => ({ success: true })),
  mcpListLearningPaths: jest.fn(async () => ({ success: true })),
  mcpListSkills: jest.fn(async () => ({ success: true })),
  mcpListTrainingCategories: jest.fn(async () => ({ success: true })),
  mcpListTrainingCourses: jest.fn(async () => ({ success: true })),
  mcpListTrainingSessions: jest.fn(async () => ({ success: true })),
  mcpUpdateCertification: jest.fn(async () => ({ success: true })),
  mcpUpdateTrainingCourse: jest.fn(async () => ({ success: true })),
  mcpUpdateTrainingEnrollmentProgress: jest.fn(async () => ({ success: true })),
  mcpUpdateTrainingEnrollmentStatus: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/services/certification.service.js', () => ({
  getCertificationKpis: jest.fn(async () => ({ success: true })),
  getEmployeeTranscript: jest.fn(async () => ({ success: true })),
}));

const { registerLearningTools } = await import('../../../src/mcp/tools/learningTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerLearningTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_training_course_create', gate: 'hr:learning', action: 'CREATE', args: { title: 'React 101', categoryId: '1' } },
  { name: 'hr_training_course_update', gate: 'hr:learning', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_training_course_delete', gate: 'hr:learning', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_training_category_create', gate: 'hr:learning', action: 'CREATE', args: { name: 'Technical' } },
  { name: 'hr_training_enrollment_create', gate: 'hr:learning', action: 'CREATE', args: { employeeId: '7', courseId: '1' } },
  { name: 'hr_training_enrollment_bulk', gate: 'hr:learning', action: 'CREATE', args: { courseId: '1', employeeIds: ['7'] } },
  { name: 'hr_training_enrollment_update_status', gate: 'hr:learning', action: 'EDIT', args: { id: '1', status: 'COMPLETED' } },
  { name: 'hr_training_enrollment_update_progress', gate: 'hr:learning', action: 'EDIT', args: { id: '1', progress: 100 } },
  { name: 'hr_training_enrollment_cancel', gate: 'hr:learning', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_certification_create', gate: 'hr:learning', action: 'CREATE', args: { employeeId: '7', name: 'AWS', issuedDate: '2026-01-01' } },
  { name: 'hr_certifications_kpis', gate: 'hr:learning', action: 'VIEW', args: {} },
  { name: 'hr_employee_transcript', gate: 'hr:learning', action: 'VIEW', args: {} },
  { name: 'hr_certifications_list', gate: 'hr:learning', action: 'VIEW', args: {} },
  { name: 'hr_certification_get', gate: 'hr:learning', action: 'VIEW', args: { id: '1' } },
  { name: 'hr_certification_update', gate: 'hr:learning', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_certification_delete', gate: 'hr:learning', action: 'DELETE', args: { id: '1' } },
  { name: 'hr_learning_path_create', gate: 'hr:learning', action: 'CREATE', args: { name: 'Engineer Path' } },
];

describe('LEARNING-SCENARIOS — registration', () => {
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

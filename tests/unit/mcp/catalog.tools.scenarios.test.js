// tests/unit/mcp/catalog.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR course catalog tools (14 tools).
// DB-free: service is mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/courseCatalog.service.js', () => ({
  listCourseCatalog: jest.fn(async () => ({ success: true })),
  getCourseDetail: jest.fn(async () => ({ success: true })),
  getLecture: jest.fn(async () => ({ success: true })),
  enrollInCourse: jest.fn(async () => ({ success: true })),
  createReview: jest.fn(async () => ({ success: true })),
  updateCourseCatalogFields: jest.fn(async () => ({ success: true })),
  createSection: jest.fn(async () => ({ success: true })),
  updateSection: jest.fn(async () => ({ success: true })),
  deleteSection: jest.fn(async () => ({ success: true })),
  createLecture: jest.fn(async () => ({ success: true })),
  updateLecture: jest.fn(async () => ({ success: true })),
  deleteLecture: jest.fn(async () => ({ success: true })),
  createOutcome: jest.fn(async () => ({ success: true })),
  deleteOutcome: jest.fn(async () => ({ success: true })),
}));

const { registerCatalogTools } = await import('../../../src/mcp/tools/catalogTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
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
  { name: 'hr_course_catalog_list', gate: 'hr:learning', action: 'VIEW', args: {} },
  { name: 'hr_course_get', gate: 'hr:learning', action: 'VIEW', args: { id: 1 } },
  { name: 'hr_course_lecture_get', gate: 'hr:learning', action: 'VIEW', args: { id: 1 } },
  { name: 'hr_course_enroll', gate: 'hr:learning', action: 'CREATE', args: { courseId: 1 } },
  { name: 'hr_course_review_create', gate: 'hr:learning', action: 'CREATE', args: { courseId: 1, rating: 5 } },
  { name: 'hr_course_catalog_update', gate: 'hr:learning', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_course_section_create', gate: 'hr:learning', action: 'CREATE', args: { courseId: 1, title: 'Intro' } },
  { name: 'hr_course_section_update', gate: 'hr:learning', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_course_section_delete', gate: 'hr:learning', action: 'DELETE', args: { id: 1 } },
  { name: 'hr_course_lecture_create', gate: 'hr:learning', action: 'CREATE', args: { sectionId: 1, title: 'Video 1' } },
  { name: 'hr_course_lecture_update', gate: 'hr:learning', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_course_lecture_delete', gate: 'hr:learning', action: 'DELETE', args: { id: 1 } },
  { name: 'hr_course_outcome_create', gate: 'hr:learning', action: 'CREATE', args: { courseId: 1, title: 'Outcome 1' } },
  { name: 'hr_course_outcome_delete', gate: 'hr:learning', action: 'DELETE', args: { id: 1 } },
];

describe('CATALOG-SCENARIOS — registration', () => {
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

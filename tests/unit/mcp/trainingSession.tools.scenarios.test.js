// tests/unit/mcp/trainingSession.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR training session tools (5 tools).
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/trainingSession.service.js', () => ({
  createSession: jest.fn(async () => ({ success: true })),
  listSessions: jest.fn(async () => ({ success: true })),
  updateSession: jest.fn(async () => ({ success: true })),
  markAttendance: jest.fn(async () => ({ success: true })),
  uploadRecording: jest.fn(async () => ({ success: true })),
}));

const { registerTrainingSessionTools } = await import('../../../src/mcp/tools/trainingSessionTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerTrainingSessionTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_training_session_list', gate: 'hr:learning', action: 'VIEW', args: { courseId: '1' } },
  { name: 'hr_training_session_create', gate: 'hr:learning', action: 'CREATE', args: { courseId: '1', title: 'Intro Session', scheduledAt: '2026-08-01T10:00:00Z' } },
  { name: 'hr_training_session_update', gate: 'hr:learning', action: 'EDIT', args: { id: '1' } },
  { name: 'hr_training_session_attendance', gate: 'hr:learning', action: 'CREATE', args: { sessionId: '1', employeeId: '7', attended: true } },
  { name: 'hr_training_session_recording_upload', gate: 'hr:learning', action: 'EDIT', args: { id: '1', fileBase64: 'dGVzdA==' } },
];

describe('TRAINING-SESSION-SCENARIOS — registration', () => {
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

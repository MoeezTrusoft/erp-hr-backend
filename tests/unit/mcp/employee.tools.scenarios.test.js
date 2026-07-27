// tests/unit/mcp/employee.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR employee & position tools (27 tools).
// DB-free: controller is mocked; tool→controller dispatch + gate is asserted.
//
// NOTE: we verify happy-path dispatch via return value (not mock call counts)
// because Jest ESM `jest.unstable_mockModule` can create separate module
// instances for static imports (employeeTools.js) vs dynamic imports (test),
// making the test's `employeeCtl.mcpXxx` a different object than the one
// the tool calls internally.  Checking the return value proves the tool
// reached the controller, called it, and returned its result.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/mcp/controllers/employeeMcpController.js', () => ({
  mcpCreateEmergencyContact: jest.fn(async () => ({ success: true })),
  mcpCreateEmployee: jest.fn(async () => ({ success: true })),
  mcpCreateEmployeeDocument: jest.fn(async () => ({ success: true })),
  mcpCreateEmployeeLifecycle: jest.fn(async () => ({ success: true })),
  mcpCreateOffboarding: jest.fn(async () => ({ success: true })),
  mcpCreatePosition: jest.fn(async () => ({ success: true })),
  mcpDeleteEmergencyContact: jest.fn(async () => ({ success: true })),
  mcpDeleteEmployee: jest.fn(async () => ({ success: true })),
  mcpDeletePosition: jest.fn(async () => ({ success: true })),
  mcpGetEmployeeById: jest.fn(async () => ({ success: true })),
  mcpGetEmployeeProfile: jest.fn(async () => ({ success: true })),
  mcpGetEmployeeProfileTab: jest.fn(async () => ({ success: true })),
  mcpGetEmployeeDocuments: jest.fn(async () => ({ success: true })),
  mcpGetEmployeeQuickView: jest.fn(async () => ({ success: true })),
  mcpGetEmployees: jest.fn(async () => ({ success: true })),
  mcpGetOrgChart: jest.fn(async () => ({ success: true })),
  mcpGetPositions: jest.fn(async () => ({ success: true })),
  mcpListEmployeesContract: jest.fn(async () => ({ success: true, items: [] })),
  mcpExportEmployees: jest.fn(async () => ({ success: true })),
  mcpListPositionsContract: jest.fn(async () => ({ success: true, items: [] })),
  mcpUpdateEmergencyContact: jest.fn(async () => ({ success: true })),
  mcpUpdateEmployee: jest.fn(async () => ({ success: true })),
  mcpUpdateEmployeeStatus: jest.fn(async () => ({ success: true })),
  mcpUpdateOffboarding: jest.fn(async () => ({ success: true })),
  mcpUpdatePosition: jest.fn(async () => ({ success: true })),
  mcpGetPositionByPositionId: jest.fn(async () => ({ success: true })),
  mcpUpdatePositionStatus: jest.fn(async () => ({ success: true })),
  mcpUploadEmployeeCoverPhoto: jest.fn(async () => ({ success: true })),
  mcpUploadEmployeeProfilePhoto: jest.fn(async () => ({ success: true })),
}));

const employeeCtl = await import('../../../src/mcp/controllers/employeeMcpController.js');
const { registerEmployeeTools } = await import('../../../src/mcp/tools/employeeTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerEmployeeTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

// All employee/position tools gate on "hr:employee" (not "hr:position").
// Exception: hr_employee_emergency_contact_create uses route path "/hr/api/emergency-contacts"
// which is a bug — it will ALWAYS 403. Tested separately below.
const TOOLS = [
  { name: 'hr_employees_list', gate: 'hr:employee', action: 'VIEW', args: { page: 1, pageSize: 10 } },
  { name: 'hr_employees_export', gate: 'hr:employee', action: 'VIEW', args: {} },
  { name: 'hr_positions_list', gate: 'hr:employee', action: 'VIEW', args: {} },
  { name: 'hr_employee_get', gate: 'hr:employee', action: 'VIEW', args: { id: 7 } },
  { name: 'hr_employee_profile_get', gate: 'hr:employee', action: 'VIEW', args: { id: 7, tab: 'personal' } },
  { name: 'hr_employee_profile_full_get', gate: 'hr:employee', action: 'VIEW', args: { id: 7, tab: 'overview' } },
  { name: 'hr_employee_quick_view_get', gate: 'hr:employee', action: 'VIEW', args: { id: 7 } },
  { name: 'hr_employee_documents_list', gate: 'hr:employee', action: 'VIEW', args: { id: 7 } },
  { name: 'hr_employee_create', gate: 'hr:employee', action: 'CREATE', args: { firstName: 'John', lastName: 'Doe' } },
  { name: 'hr_employee_update', gate: 'hr:employee', action: 'EDIT', args: { id: 7, firstName: 'Jane' } },
  { name: 'hr_employee_status_update', gate: 'hr:employee', action: 'EDIT', args: { id: 7, status: 'active' } },
  { name: 'hr_employee_delete', gate: 'hr:employee', action: 'DELETE', args: { id: 7 } },
  { name: 'hr_employee_profile_photo_attach', gate: 'hr:employee', action: 'EDIT', args: { id: 7, mediaId: 'm1' } },
  { name: 'hr_employee_cover_photo_attach', gate: 'hr:employee', action: 'EDIT', args: { id: 7, mediaId: 'm1' } },
  { name: 'hr_employee_document_create', gate: 'hr:employee', action: 'CREATE', args: { employeeId: 7, mediaId: 'm1' } },
  { name: 'hr_position_create', gate: 'hr:employee', action: 'CREATE', args: { title: 'Engineer' } },
  { name: 'hr_position_update', gate: 'hr:employee', action: 'EDIT', args: { id: 1, title: 'Senior' } },
  { name: 'hr_position_status_update', gate: 'hr:employee', action: 'EDIT', args: { id: 1, status: 'active' } },
  { name: 'hr_position_delete', gate: 'hr:employee', action: 'DELETE', args: { id: 1 } },
  { name: 'hr_position_get', gate: 'hr:employee', action: 'VIEW', args: { id: 1 } },
  { name: 'hr_employee_lifecycle_create', gate: 'hr:employee', action: 'CREATE', args: { employeeId: 7, type: 'promotion' } },
  { name: 'hr_offboarding_create', gate: 'hr:employee', action: 'CREATE', args: { employeeId: 7 } },
  { name: 'hr_offboarding_update', gate: 'hr:employee', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_emergency_contact_create', gate: 'hr:employee', action: 'CREATE', args: { employeeId: 7, name: 'Dad' } },
  { name: 'hr_emergency_contact_update', gate: 'hr:employee', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_emergency_contact_delete', gate: 'hr:employee', action: 'DELETE', args: { id: 1 } },
  { name: 'hr_employee_emergency_contacts_list', gate: 'hr:employee', action: 'VIEW', args: { id: 7 } },
];

describe('EMPLOYEE-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
  it('hr_employee_emergency_contact_create is registered', () => {
    expect(handlers.has('hr_employee_emergency_contact_create')).toBe(true);
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

// KNOWN BUG: hr_employee_emergency_contact_create uses route path


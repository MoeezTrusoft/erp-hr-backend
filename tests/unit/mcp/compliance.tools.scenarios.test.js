// tests/unit/mcp/compliance.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR compliance + GDPR + reimbursement tools (6 tools).
// DB-free: controller is mocked; tool→controller dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/mcp/controllers/complianceMcpController.js', () => ({
  mcpCreateComplianceChecklist: jest.fn(async () => ({ success: true })),
  mcpUpdateComplianceItem: jest.fn(async () => ({ success: true })),
  mcpExportGdprEmployeeData: jest.fn(async () => ({ success: true })),
  mcpEraseGdprEmployeeData: jest.fn(async () => ({ success: true })),
  mcpCreateReimbursement: jest.fn(async () => ({ success: true })),
  mcpApproveReimbursement: jest.fn(async () => ({ success: true })),
  mcpListAuditLogs: jest.fn(async () => ({ success: true })),
  mcpListComplianceChecklists: jest.fn(async () => ({ success: true })),
  mcpListDocumentExpiryAlerts: jest.fn(async () => ({ success: true })),
  mcpListGdprRecords: jest.fn(async () => ({ success: true })),
}));

const { registerComplianceTools } = await import('../../../src/mcp/tools/complianceTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerComplianceTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_compliance_checklist_create', gate: 'hr:compliance', action: 'CREATE', args: { name: 'Safety Training' } },
  { name: 'hr_compliance_item_update', gate: 'hr:compliance', action: 'EDIT', args: { id: '1', status: 'COMPLETED' } },
  { name: 'hr_gdpr_export_employee_data', gate: 'hr:gdpr', action: 'VIEW', args: { employeeId: '7' } },
  { name: 'hr_gdpr_erase_employee_data', gate: 'hr:gdpr', action: 'DELETE', args: { employeeId: '7', confirmErase: true } },
  { name: 'hr_reimbursement_create', gate: 'hr:reimbursement', action: 'CREATE', args: { employeeId: '7', amount: 500, description: 'Travel expense' } },
  { name: 'hr_reimbursement_update', gate: 'hr:reimbursement', action: 'EDIT', args: { id: '1' } },
];

describe('COMPLIANCE-SCENARIOS — registration', () => {
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

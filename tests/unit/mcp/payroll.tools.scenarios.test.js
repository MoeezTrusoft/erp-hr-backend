// tests/unit/mcp/payroll.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR payroll tools (13 tools).
// DB-free: controller is mocked; tool→controller dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/mcp/controllers/payrollMcpController.js', () => ({
  mcpCancelPayrollRun: jest.fn(async () => ({ success: true })),
  mcpCreateDeductionType: jest.fn(async () => ({ success: true })),
  mcpCreateEarningType: jest.fn(async () => ({ success: true })),
  mcpCreateEmploymentTerms: jest.fn(async () => ({ success: true })),
  mcpCreatePayrollAssignment: jest.fn(async () => ({ success: true })),
  mcpCreatePayrollRun: jest.fn(async () => ({ success: true })),
  mcpDistributePayslip: jest.fn(async () => ({ success: true })),
  mcpFinalizePayrollRun: jest.fn(async () => ({ success: true })),
  mcpListDeductionTypes: jest.fn(async () => ({ success: true })),
  mcpListEarningTypes: jest.fn(async () => ({ success: true })),
  mcpListPayrollAuditLogs: jest.fn(async () => ({ success: true })),
  mcpListPayrollRuns: jest.fn(async () => ({ success: true })),
  mcpListPayslips: jest.fn(async () => ({ success: true })),
  mcpProcessPayrollRun: jest.fn(async () => ({ success: true })),
  mcpExportBankDisbursementFile: jest.fn(async () => ({ success: true })),
}));
jest.unstable_mockModule('../../../src/mcp/controllers/taxFormMcpController.js', () => ({
  mcpListYearEndTaxForms: jest.fn(async () => ({ success: true, data: [] })),
  mcpExportYearEndTaxForms: jest.fn(async () => ({ success: true, data: [] })),
}));

const payrollCtl = await import('../../../src/mcp/controllers/payrollMcpController.js');
const taxCtl = await import('../../../src/mcp/controllers/taxFormMcpController.js');
const { registerPayrollTools } = await import('../../../src/mcp/tools/payrollTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerPayrollTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_payslips_list', ctrl: () => payrollCtl.mcpListPayslips, gate: 'hr:payroll', action: 'VIEW', args: { page: 1, pageSize: 10 } },
  { name: 'hr_payroll_run_create', ctrl: () => payrollCtl.mcpCreatePayrollRun, gate: 'hr:payroll', action: 'CREATE', args: { month: 1, year: 2026 } },
  { name: 'hr_payroll_run_process', ctrl: () => payrollCtl.mcpProcessPayrollRun, gate: 'hr:payroll', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_payroll_run_finalize', ctrl: () => payrollCtl.mcpFinalizePayrollRun, gate: 'hr:payroll', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_payroll_run_delete', ctrl: () => payrollCtl.mcpCancelPayrollRun, gate: 'hr:payroll', action: 'DELETE', args: { id: 1 } },
  { name: 'hr_payslip_distribute', ctrl: () => payrollCtl.mcpDistributePayslip, gate: 'hr:payroll', action: 'CREATE', args: { id: '1' } },
  { name: 'hr_payroll_employment_terms_create', ctrl: () => payrollCtl.mcpCreateEmploymentTerms, gate: 'hr:payroll', action: 'CREATE', args: { employeeId: 7 } },
  { name: 'hr_payroll_assignment_create', ctrl: () => payrollCtl.mcpCreatePayrollAssignment, gate: 'hr:payroll', action: 'CREATE', args: { employeeId: 7 } },
  { name: 'hr_payroll_earning_type_create', ctrl: () => payrollCtl.mcpCreateEarningType, gate: 'hr:payroll', action: 'CREATE', args: { name: 'Basic' } },
  { name: 'hr_payroll_deduction_type_create', ctrl: () => payrollCtl.mcpCreateDeductionType, gate: 'hr:payroll', action: 'CREATE', args: { name: 'Tax' } },
  { name: 'hr_payroll_bank_file_export', ctrl: () => payrollCtl.mcpExportBankDisbursementFile, gate: 'hr:payroll', action: 'VIEW', args: { payrollRunId: 1 } },
  { name: 'hr_tax_forms_list', ctrl: () => taxCtl.mcpListYearEndTaxForms, gate: 'hr:payroll', action: 'VIEW', args: {} },
  { name: 'hr_tax_forms_export', ctrl: () => taxCtl.mcpExportYearEndTaxForms, gate: 'hr:payroll', action: 'VIEW', args: {} },
];

describe('PAYROLL-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, ctrl: ctrlOf, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to controller with verified tenant', async () => {
    await call(name, args, { permissions: grant });
    expect(ctrlOf()).toHaveBeenCalledTimes(1);
    expect(ctrlOf().mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-A' });
  });

  it('deny-by-default: no permission blob -> 403', async () => {
    const res = await call(name, args, { permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
    expect(ctrlOf()).not.toHaveBeenCalled();
  });

  it('forged isAdmin grants nothing (still 403)', async () => {
    const res = await call(name, args, { user: { ...USER, isAdmin: true }, permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
    expect(ctrlOf()).not.toHaveBeenCalled();
  });
});

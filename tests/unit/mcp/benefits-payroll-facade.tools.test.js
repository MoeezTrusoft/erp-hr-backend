// tests/unit/mcp/benefits-payroll-facade.tools.test.js
//
// HR-BENEFITS-04 / HR-BANKFILE-03 / HR-PAY-07 — the new hr_ MCP tools that wrap
// the EXISTING benefits + payroll(bank-file/tax-form) REST surface must:
//   * dispatch to the underlying service controller with the right args,
//   * be deny-by-default permission-gated on the SAME entitlement the REST
//     route uses (hr:benefits / hr:payroll) for the method's action,
//   * carry the VERIFIED tenant (ctx.user.tenantId) into every dispatch.
//
// We mock the MCP controller layer (the thin runController wrappers) so the test
// is DB-free and asserts the tool→controller dispatch contract directly.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/mcp/controllers/benefitMcpController.js', () => ({
  mcpListBenefitPlans: jest.fn(async () => ({ ok: 'list' })),
  mcpGetBenefitPlan: jest.fn(async () => ({ ok: 'get' })),
  mcpCreateBenefitPlan: jest.fn(async () => ({ ok: 'create' })),
  mcpUpdateBenefitPlan: jest.fn(async () => ({ ok: 'update' })),
  mcpDeleteBenefitPlan: jest.fn(async () => ({ ok: 'delete' })),
  mcpEnrollBenefit: jest.fn(async () => ({ ok: 'enroll' })),
  mcpUnenrollBenefit: jest.fn(async () => ({ ok: 'unenroll' })),
  mcpListEmployeeBenefits: jest.fn(async () => ({ ok: 'empben' })),
}));

jest.unstable_mockModule('../../../src/mcp/controllers/taxFormMcpController.js', () => ({
  mcpListYearEndTaxForms: jest.fn(async () => ({ ok: 'taxlist' })),
  mcpExportYearEndTaxForms: jest.fn(async () => 'CSV,CONTENT'),
}));

jest.unstable_mockModule('../../../src/mcp/controllers/payrollMcpController.js', () => ({
  // payrollTools imports the full payroll surface; only the bank-file export is
  // exercised here, the rest are present so the module links.
  mcpExportBankDisbursementFile: jest.fn(async () => 'NACHA-CONTENT'),
  mcpCancelPayrollRun: jest.fn(),
  mcpCreateDeductionType: jest.fn(),
  mcpCreateEarningType: jest.fn(),
  mcpCreateEmploymentTerms: jest.fn(),
  mcpCreatePayrollAssignment: jest.fn(),
  mcpCreatePayrollRun: jest.fn(),
  mcpDistributePayslip: jest.fn(),
  mcpFinalizePayrollRun: jest.fn(),
  mcpListDeductionTypes: jest.fn(),
  mcpListEarningTypes: jest.fn(),
  mcpListPayrollAuditLogs: jest.fn(),
  mcpListPayrollRuns: jest.fn(),
  mcpListPayslips: jest.fn(),
  mcpProcessPayrollRun: jest.fn(),
}));

const benefitCtl = await import('../../../src/mcp/controllers/benefitMcpController.js');
const taxCtl = await import('../../../src/mcp/controllers/taxFormMcpController.js');
const payrollCtl = await import('../../../src/mcp/controllers/payrollMcpController.js');
const { registerBenefitTools } = await import('../../../src/mcp/tools/benefitTools.js');
const { registerPayrollTools } = await import('../../../src/mcp/tools/payrollTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

// Capture the registered tool handlers by name from a recording server.
const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerBenefitTools(recording);
registerPayrollTools(recording);

const USER = {
  userId: '7',
  email: 'dpo@acme.test',
  roles: ['HR_ADMIN'],
  isAdmin: false, // forgeable flag must NOT grant anything
  employeeId: '7',
  tenantId: 'tenant-A',
};
const FULL = {
  'hr:benefits': ['VIEW', 'CREATE', 'EDIT', 'DELETE'],
  'hr:payroll': ['VIEW', 'CREATE', 'EDIT', 'DELETE'],
};

function call(name, args, { user = USER, permissions = FULL } = {}) {
  return mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
}

const parseErr = (res) => JSON.parse(res.content[0].text);

// name, input args, controller mock, expected dispatch args, gate key, action
const CASES = [
  ['hr_benefit_plan_list', {}, () => benefitCtl.mcpListBenefitPlans, [USER, {}], 'hr:benefits', 'VIEW'],
  ['hr_benefit_plan_get', { id: '5' }, () => benefitCtl.mcpGetBenefitPlan, [USER, '5'], 'hr:benefits', 'VIEW'],
  ['hr_benefit_plan_create', { name: 'Gold', type: 'HEALTH' }, () => benefitCtl.mcpCreateBenefitPlan, [USER, { name: 'Gold', type: 'HEALTH' }], 'hr:benefits', 'CREATE'],
  ['hr_benefit_plan_update', { id: '5', name: 'X' }, () => benefitCtl.mcpUpdateBenefitPlan, [USER, '5', { name: 'X' }], 'hr:benefits', 'EDIT'],
  ['hr_benefit_plan_delete', { id: '5' }, () => benefitCtl.mcpDeleteBenefitPlan, [USER, '5'], 'hr:benefits', 'DELETE'],
  ['hr_benefit_enroll', { employeeId: '9', benefitPlanId: '5', electedAmount: 100 }, () => benefitCtl.mcpEnrollBenefit, [USER, '9', { benefitPlanId: '5', electedAmount: 100 }], 'hr:benefits', 'CREATE'],
  ['hr_benefit_unenroll', { employeeId: '9', benefitPlanId: '5' }, () => benefitCtl.mcpUnenrollBenefit, [USER, '9', '5'], 'hr:benefits', 'DELETE'],
  ['hr_employee_benefits_list', { employeeId: '9', status: 'ACTIVE' }, () => benefitCtl.mcpListEmployeeBenefits, [USER, '9', { status: 'ACTIVE' }], 'hr:benefits', 'VIEW'],
  ['hr_payroll_bank_file_export', { id: '3', format: 'csv' }, () => payrollCtl.mcpExportBankDisbursementFile, [USER, '3', { format: 'csv' }], 'hr:payroll', 'VIEW'],
  ['hr_tax_forms_list', { taxYear: '2025' }, () => taxCtl.mcpListYearEndTaxForms, [USER, '2025'], 'hr:payroll', 'VIEW'],
  ['hr_tax_forms_export', { taxYear: '2025', formType: 'w2', format: 'csv' }, () => taxCtl.mcpExportYearEndTaxForms, [USER, '2025', { formType: 'w2', format: 'csv' }], 'hr:payroll', 'VIEW'],
];

describe('hr_ benefits + payroll(bank-file/tax-form) MCP facade', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers all eight benefit + three payroll-export tools', () => {
    for (const [name] of CASES) expect(handlers.has(name)).toBe(true);
  });

  describe.each(CASES)('%s', (name, args, fnOf, expectedArgs, gateKey, action) => {
    it('dispatches to the service controller with the right args + verified tenant', async () => {
      const res = await call(name, args);
      expect(res.isError).toBeFalsy();
      expect(fnOf()).toHaveBeenCalledTimes(1);
      expect(fnOf()).toHaveBeenCalledWith(...expectedArgs);
      // the dispatched user carries the VERIFIED tenant from ctx, never the body
      expect(fnOf().mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-A' });
    });

    it('is deny-by-default: no permission blob → 403 and the service is never called', async () => {
      const res = await call(name, args, { permissions: {} });
      expect(res.isError).toBe(true);
      expect(parseErr(res).status).toBe(403);
      expect(fnOf()).not.toHaveBeenCalled();
    });

    it(`requires ${gateKey}:${action} specifically (a forged isAdmin grants nothing)`, async () => {
      // an admin flag with an empty permission blob must NOT pass
      const res = await call(name, args, { user: { ...USER, isAdmin: true }, permissions: {} });
      expect(res.isError).toBe(true);
      expect(parseErr(res).status).toBe(403);
      expect(fnOf()).not.toHaveBeenCalled();
    });

    it(`denies when the blob lacks the ${action} action (wrong action only)`, async () => {
      const others = ['VIEW', 'CREATE', 'EDIT', 'DELETE'].filter((a) => a !== action);
      const res = await call(name, args, { permissions: { [gateKey]: others } });
      expect(res.isError).toBe(true);
      expect(parseErr(res).status).toBe(403);
      expect(fnOf()).not.toHaveBeenCalled();
    });
  });
});

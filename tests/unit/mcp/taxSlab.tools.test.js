// Tax slab tools: the one-slab-at-a-time writers are closed, the set request is gated on the payroll grant and
// sends the verified tenant and the signed-in employee.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/taxSlabChangeRequest.service.js', () => ({
  requestTaxSlabSet: jest.fn(async () => ({ pendingApproval: true })),
  listPendingTaxSlabChanges: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../../src/services/payrollTaxSlab.service.js', () => ({ listTaxSlabs: jest.fn(async () => ({ items: [] })) }));
jest.unstable_mockModule('../../../src/services/payrollCalendar.service.js', () => ({ getCalendar: jest.fn(), upsertCalendar: jest.fn() }));
jest.unstable_mockModule('../../../src/services/payrollApprovalMatrix.service.js', () => ({
  createApprovalLevel: jest.fn(), updateApprovalLevel: jest.fn(), deleteApprovalLevel: jest.fn(), listApprovalLevels: jest.fn(),
}));

const svc = await import('../../../src/services/taxSlabChangeRequest.service.js');
const { registerPayrollConfigTools } = await import('../../../src/mcp/tools/payrollConfigTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
registerPayrollConfigTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });
const USER = { userId: '7', roles: ['HR_ADMIN'], isAdmin: false, employeeId: '7', tenantId: 'tenant-A' };
const call = (name, args, permissions) => mcpCtx.run({ user: USER, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);
const GRANT = { 'hr:payroll': ['VIEW', 'EDIT', 'CREATE', 'DELETE'] };
const REQUEST = { effectiveFrom: '2031-07-01', slabs: [{ upto: 100, ratePct: 1 }, { ratePct: 5 }], reason: 'New year' };

describe('tax slab tools', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['hr_tax_slab_create', { bracketMin: 0, rate: 0.1 }],
    ['hr_tax_slab_update', { id: 1, rate: 0.2 }],
    ['hr_tax_slab_delete', { id: 1 }],
  ])('%s is closed, even for someone with every payroll grant', async (name, args) => {
    const res = await call(name, args, GRANT);
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(409);
    expect(parse(res).message ?? parse(res).error).toMatch(/whole slab set for approval/);
  });

  it('the set request sends the verified tenant and the signed-in employee', async () => {
    await call('hr_tax_slab_set_request', REQUEST, GRANT);
    expect(svc.requestTaxSlabSet).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-A', requestedById: '7', effectiveFrom: '2031-07-01' }));
  });

  it('the set request and the waiting list are denied without the payroll grant', async () => {
    for (const [name, args] of [['hr_tax_slab_set_request', REQUEST], ['hr_tax_slab_changes_pending', {}]]) {
      const res = await call(name, args, {});
      expect(res.isError).toBe(true);
      expect(parse(res).status).toBe(403);
    }
    expect(svc.requestTaxSlabSet).not.toHaveBeenCalled();
    expect(svc.listPendingTaxSlabChanges).not.toHaveBeenCalled();
  });

  it('a view-only payroll grant cannot send a change but can see what is waiting', async () => {
    const view = { 'hr:payroll': ['VIEW'] };
    expect((await call('hr_tax_slab_set_request', REQUEST, view)).isError).toBe(true);
    expect((await call('hr_tax_slab_changes_pending', {}, view)).isError).not.toBe(true);
  });
});

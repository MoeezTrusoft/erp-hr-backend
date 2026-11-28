// HR-MCP-RESOURCE-01 — every HR MCP resource is permission-gated.
//
// resources/read skips the gateway's tools/call precheck, and most HR resources
// had no check of their own: on dev a plain employee read hr://payroll/payslips
// (every colleague's pay), hr://employees and hr://compliance/gdpr-records.
import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) }),
}));

const { resourceGateFor, withResourceGates } = await import('../../../src/mcp/utils/resourceGate.js');
const { registerAllTools } = await import('../../../src/mcp/toolRegistry.js');

// The dev EMPLOYEE role, verbatim from a login token.
const EMPLOYEE = {
  'hr:self': ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'EXPORT'],
  'hr:leave': ['VIEW'], 'hr:attendance': ['VIEW'], 'hr:holiday': ['VIEW'], 'hr:approvals:self': ['VIEW'],
};
const PAYROLL_ADMIN = { 'hr:payroll': ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'EXPORT'] };
const HR = {
  'hr:employee': ['VIEW', 'EDIT'], 'hr:leave': ['VIEW', 'EDIT'], 'hr:attendance': ['VIEW', 'EDIT'],
  'hr:compliance': ['VIEW'], 'hr:recruitment': ['VIEW'],
};
const user = { employeeId: 1, tenantId: 't' };
const can = (uri, perms) => { try { resourceGateFor(uri)(user, perms); return true; } catch (e) { expect(e.status).toBe(403); return false; } };

const registered = () => {
  const uris = [];
  registerAllTools({ tool() {}, registerTool() {}, resource: (_n, uri) => uris.push(String(uri?.uriTemplate ?? uri)) });
  return uris;
};

describe('HR-MCP-RESOURCE-01 resource gate', () => {
  it('a plain employee cannot read company payroll, people or compliance data', () => {
    for (const uri of ['hr://payroll/payslips', 'hr://payroll/runs', 'hr://payroll/earning-types', 'hr://employees',
      'hr://compliance/gdpr-records', 'hr://compliance/audit-logs', 'hr://leaves/requests', 'hr://leaves/balances',
      'hr://attendance/records', 'hr://timesheets', 'hr://performance/reviews', 'hr://recruitment/candidates']) {
      expect([uri, can(uri, EMPLOYEE)]).toEqual([uri, false]);
    }
  });

  it('a plain employee still reads their own rows and the leave reference data', () => {
    for (const uri of ['hr://self/payslips', 'hr://self/profile', 'hr://holidays', 'hr://leaves/policies']) {
      expect([uri, can(uri, EMPLOYEE)]).toEqual([uri, true]);
    }
  });

  it('payroll needs the payroll admin surface; HR staff reach their own modules only', () => {
    expect(can('hr://payroll/payslips', PAYROLL_ADMIN)).toBe(true);
    expect(can('hr://payroll/payslips', HR)).toBe(false);
    expect(can('hr://employees', HR)).toBe(true);
    expect(can('hr://leaves/requests', HR)).toBe(true);
    expect(can('hr://attendance/records', HR)).toBe(true);
    expect(can('hr://performance/reviews', HR)).toBe(false);
  });

  it('an unknown resource is refused (fail closed)', () => {
    expect(can('hr://something/new', { ...HR, ...PAYROLL_ADMIN })).toBe(false);
  });

  it('every registered HR resource has an explicit rule', () => {
    const uris = registered();
    expect(uris.length).toBeGreaterThan(40);
    const unmatched = uris.filter((uri) => {
      try { resourceGateFor(uri)(user, {}); return false; } catch (e) { return /no access rule/.test(e.message); }
    });
    expect(unmatched).toEqual([]);
  });

  it('the wrapper runs the gate before the handler and requires a session', async () => {
    const handlers = {};
    let ctx = { user, permissions: EMPLOYEE };
    const server = withResourceGates({ resource: (n, _u, _m, cb) => { handlers[n] = cb; } }, () => ctx);
    const handler = jest.fn(async () => ({ contents: [] }));
    server.resource('payslips', 'hr://payroll/payslips', {}, handler);
    await expect(handlers.payslips(new URL('hr://payroll/payslips'))).rejects.toMatchObject({ status: 403 });
    expect(handler).not.toHaveBeenCalled();
    ctx = { user, permissions: PAYROLL_ADMIN };
    await expect(handlers.payslips(new URL('hr://payroll/payslips'))).resolves.toEqual({ contents: [] });
    ctx = undefined;
    await expect(handlers.payslips(new URL('hr://payroll/payslips'))).rejects.toMatchObject({ status: 401 });
  });
});

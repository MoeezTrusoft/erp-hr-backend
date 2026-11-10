// An employee can ask for a loan or advance and see their own without any loan grant; the service gets the verified
// tenant and the signed-in employee, never ids from the call.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/loan.service.js', () => ({
  requestMyLoan: jest.fn(async () => ({ requested: true })),
  listMyLoans: jest.fn(async () => ({ items: [] })),
  createLoan: jest.fn(async () => ({ id: 1 })),
  listLoans: jest.fn(), getLoan: jest.fn(), getLoanKpis: jest.fn(), approveLoan: jest.fn(), writeOffLoan: jest.fn(),
}));
const svc = await import('../../../src/services/loan.service.js');
const { registerLoanTools } = await import('../../../src/mcp/tools/loanTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
registerLoanTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]) });
const USER = { userId: '7', roles: ['EMPLOYEE'], isAdmin: false, employeeId: '7', tenantId: 'tenant-A' };
const call = (name, args, { user = USER, permissions = {} } = {}) => mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

describe('loan self-service tools', () => {
  beforeEach(() => jest.clearAllMocks());

  it('an employee with no loan grant can ask for an advance for themselves', async () => {
    const res = await call('hr_loan_request_mine', { kind: 'ADVANCE', principalMinor: 5000000, reason: 'School fees' });
    expect(res.isError).not.toBe(true);
    expect(svc.requestMyLoan).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-A', employeeId: '7', kind: 'ADVANCE', principalMinor: 5000000 }));
  });
  it('a loan needs a repayment period', async () => {
    const res = await call('hr_loan_request_mine', { principalMinor: 5000000, reason: 'Home repair' });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(400);
    expect(svc.requestMyLoan).not.toHaveBeenCalled();
  });
  it('the employee id comes from the session, even if one is passed', async () => {
    await call('hr_loan_request_mine', { kind: 'ADVANCE', principalMinor: 100, reason: 'abc', employeeId: 99 });
    expect(svc.requestMyLoan.mock.calls[0][0].employeeId).toBe('7');
  });
  it('own loans need a signed-in employee and use the session', async () => {
    await call('hr_loan_mine', {});
    expect(svc.listMyLoans).toHaveBeenCalledWith({ tenantId: 'tenant-A', employeeId: '7' });
    const res = await call('hr_loan_mine', {}, { user: { ...USER, employeeId: undefined } });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });
  it('listing every loan still needs the loan grant', async () => {
    const res = await call('hr_loan_list', {});
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });
});

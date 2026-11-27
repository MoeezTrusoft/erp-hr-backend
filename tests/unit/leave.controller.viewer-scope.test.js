// HR-LEAVE-SCOPE-02 — every employee holds hr:leave VIEW (hr.leave.read), so the
// leave controllers must not hand that session other employees' leave: the
// pending queue, balances, a request's approval history, or a request by id.
// DB-free: the leave service is mocked; the scope passed to it is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/leave.service.js', () => ({
  getPendingApprovals: jest.fn(async () => []),
  getLeaveBalances: jest.fn(async () => []),
  getLeaveRequests: jest.fn(async () => []),
  getLeaveRequestById: jest.fn(async () => null),
  getLeaveRequestApprovals: jest.fn(async () => [{ id: 1 }]),
  getEmployeeLeaveBalances: jest.fn(async () => []),
}));

const svc = await import('../../src/services/leave.service.js');
const ctl = await import('../../src/controllers/leave.controller.js');
const { mcpCtx } = await import('../../src/mcp/context.js');

// REST shape: authorizeHrRoute puts the verified canonical scope on req.user.
const EMPLOYEE = { employeeId: 7, roles: ['SALES_REP', 'EMPLOYEE'], role: 'SALES_REP', permissions: ['hr.leave.read'], tenantId: 't1' };
const HR = { employeeId: 3, roles: ['HR_ADMIN'], role: 'HR_ADMIN', permissions: ['hr.leave.read', 'hr.leave.update'], tenantId: 't1' };

const run = async (handler, user, { params = {}, query = {} } = {}) => {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await handler({ user, params, query, body: {}, headers: {} }, res);
  return { status, body };
};

beforeEach(() => jest.clearAllMocks());

describe('pending approvals queue', () => {
  it('an employee (any first role) sees only their own pending requests', async () => {
    await run(ctl.getPendingApprovals, EMPLOYEE);
    expect(svc.getPendingApprovals).toHaveBeenCalledWith({ onlyEmployeeId: 7 });
  });
  it('HR sees the company queue', async () => {
    await run(ctl.getPendingApprovals, HR);
    expect(svc.getPendingApprovals).toHaveBeenCalledWith({ onlyEmployeeId: null });
  });
  it('the MCP path reads the scope from the ambient context', async () => {
    const user = { ...EMPLOYEE, permissions: undefined };
    await mcpCtx.run({ user, permissions: { 'hr:leave': ['VIEW'] } }, () => run(ctl.getPendingApprovals, user));
    expect(svc.getPendingApprovals).toHaveBeenCalledWith({ onlyEmployeeId: 7 });
  });
});

describe('balances', () => {
  it('an employee is pinned to their own balances, whatever the query says', async () => {
    await run(ctl.getLeaveBalances, EMPLOYEE, { query: { employeeId: '9' } });
    expect(svc.getLeaveBalances).toHaveBeenCalledWith({ employeeId: 7 });
  });
  it('HR may filter by any employee', async () => {
    await run(ctl.getLeaveBalances, HR, { query: { employeeId: '9' } });
    expect(svc.getLeaveBalances).toHaveBeenCalledWith({ employeeId: '9' });
  });
  it('the per-employee route ignores a foreign id for an employee', async () => {
    await run(ctl.getEmployeeLeaveBalances, EMPLOYEE, { params: { employeeId: '9' } });
    expect(svc.getEmployeeLeaveBalances).toHaveBeenCalledWith(7);
  });
});

describe('requests list and single request', () => {
  it('a non-HR session whose first role is not EMPLOYEE is still pinned to itself', async () => {
    await run(ctl.getLeaveRequests, EMPLOYEE);
    expect(svc.getLeaveRequests).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7 }));
  });
  it("someone else's request is refused, one the caller raised is allowed", async () => {
    svc.getLeaveRequestById.mockResolvedValueOnce({ id: 2, employeeId: 9, createdById: 9 });
    expect((await run(ctl.getLeaveRequestById, EMPLOYEE, { params: { id: '2' } })).status).toBe(403);
    svc.getLeaveRequestById.mockResolvedValueOnce({ id: 3, employeeId: 9, createdById: 7 });
    expect((await run(ctl.getLeaveRequestById, EMPLOYEE, { params: { id: '3' } })).status).toBe(200);
  });
});

describe("a request's approval history", () => {
  it("is hidden from an employee for someone else's request", async () => {
    svc.getLeaveRequestById.mockResolvedValueOnce({ id: 2, employeeId: 9, createdById: 9 });
    const { status } = await run(ctl.getLeaveRequestApprovals, EMPLOYEE, { params: { id: '2' } });
    expect(status).toBe(404);
    expect(svc.getLeaveRequestApprovals).not.toHaveBeenCalled();
  });
  it('is shown for their own request and to HR', async () => {
    svc.getLeaveRequestById.mockResolvedValueOnce({ id: 3, employeeId: 7, createdById: 7 });
    expect((await run(ctl.getLeaveRequestApprovals, EMPLOYEE, { params: { id: '3' } })).status).toBe(200);
    expect((await run(ctl.getLeaveRequestApprovals, HR, { params: { id: '2' } })).status).toBe(200);
    expect(svc.getLeaveRequestApprovals).toHaveBeenCalledTimes(2);
  });
});

// tests/unit/mcp/leave.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR leave management tools (11 tools).
// DB-free: controller is mocked; tool→controller dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/mcp/controllers/leaveMcpController.js', () => ({
  mcpApproveLeaveRequest: jest.fn(async () => ({ success: true })),
  mcpCancelLeaveRequest: jest.fn(async () => ({ success: true })),
  mcpCreateHoliday: jest.fn(async () => ({ success: true })),
  mcpCreateLeavePolicy: jest.fn(async () => ({ success: true })),
  mcpCreateLeaveRequest: jest.fn(async () => ({ success: true })),
  mcpDeleteLeavePolicy: jest.fn(async () => ({ success: true })),
  mcpListHolidays: jest.fn(async () => ({ success: true })),
  mcpListLeaveBalances: jest.fn(async () => ({ success: true })),
  mcpListLeavePolicies: jest.fn(async () => ({ success: true })),
  mcpListLeaveRequests: jest.fn(async () => ({ success: true })),
  mcpListPendingLeaveApprovals: jest.fn(async () => ({ success: true })),
  mcpRejectLeaveRequest: jest.fn(async () => ({ success: true })),
  mcpRunLeaveAccruals: jest.fn(async () => ({ success: true })),
  mcpUpdateLeaveBalance: jest.fn(async () => ({ success: true })),
  mcpUpdateLeavePolicy: jest.fn(async () => ({ success: true })),
}));

const leaveCtl = await import('../../../src/mcp/controllers/leaveMcpController.js');
const { registerLeaveTools } = await import('../../../src/mcp/tools/leaveTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerLeaveTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_leave_requests_list', ctrl: () => leaveCtl.mcpListLeaveRequests, gate: 'hr:leave', action: 'VIEW', args: { page: 1, pageSize: 10 } },
  { name: 'hr_leave_request_create', ctrl: () => leaveCtl.mcpCreateLeaveRequest, gate: 'hr:leave', action: 'CREATE', args: { employeeId: 7, leaveType: 'annual' } },
  { name: 'hr_leave_request_approve', ctrl: () => leaveCtl.mcpApproveLeaveRequest, gate: 'hr:leave', action: 'CREATE', args: { id: '1' } },
  { name: 'hr_leave_request_reject', ctrl: () => leaveCtl.mcpRejectLeaveRequest, gate: 'hr:leave', action: 'CREATE', args: { id: '1', reason: 'Not enough coverage' } },
  { name: 'hr_leave_request_cancel', ctrl: () => leaveCtl.mcpCancelLeaveRequest, gate: 'hr:leave', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_leave_policy_create', ctrl: () => leaveCtl.mcpCreateLeavePolicy, gate: 'hr:leave', action: 'CREATE', args: { name: 'Annual Leave' } },
  { name: 'hr_leave_policy_update', ctrl: () => leaveCtl.mcpUpdateLeavePolicy, gate: 'hr:leave', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_leave_policy_delete', ctrl: () => leaveCtl.mcpDeleteLeavePolicy, gate: 'hr:leave', action: 'DELETE', args: { id: 1 } },
  { name: 'hr_leave_balance_update', ctrl: () => leaveCtl.mcpUpdateLeaveBalance, gate: 'hr:leave', action: 'EDIT', args: { employeeId: 7 } },
  { name: 'hr_leave_accruals_run', ctrl: () => leaveCtl.mcpRunLeaveAccruals, gate: 'hr:leave', action: 'CREATE', args: {} },
  { name: 'hr_holiday_create', ctrl: () => leaveCtl.mcpCreateHoliday, gate: 'hr:leave', action: 'CREATE', args: { name: 'Eid', date: '2026-01-01' } },
];

describe('LEAVE-SCENARIOS — registration', () => {
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

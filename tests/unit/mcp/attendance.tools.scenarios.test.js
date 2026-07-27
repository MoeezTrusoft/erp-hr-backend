// tests/unit/mcp/attendance.tools.scenarios.test.js
//
// Per-tool scenario matrix for HR attendance & time-tracking tools (18 tools).
// DB-free: controller is mocked; tool→controller dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/mcp/controllers/attendanceMcpController.js', () => ({
  mcpApproveTimesheet: jest.fn(async () => ({ success: true })),
  mcpCheckIn: jest.fn(async () => ({ success: true })),
  mcpCheckOut: jest.fn(async () => ({ success: true })),
  mcpAttendanceDailySummary: jest.fn(async () => ({ success: true })),
  mcpCreateOvertimeRule: jest.fn(async () => ({ success: true })),
  mcpCreateTimeEntry: jest.fn(async () => ({ success: true })),
  mcpCreateTimesheet: jest.fn(async () => ({ success: true })),
  mcpDeviceConnectivity: jest.fn(async () => ({ success: true })),
  mcpDeviceSyncAttendance: jest.fn(async () => ({ success: true })),
  mcpCreateWorkSchedule: jest.fn(async () => ({ success: true })),
  mcpDeleteOvertimeRule: jest.fn(async () => ({ success: true })),
  mcpDeleteTimeEntry: jest.fn(async () => ({ success: true })),
  mcpDeleteWorkSchedule: jest.fn(async () => ({ success: true })),
  mcpGetAttendanceByEmployee: jest.fn(async () => ({ success: true })),
  mcpListOvertimeRules: jest.fn(async () => ({ success: true })),
  mcpListTimeEntries: jest.fn(async () => ({ success: true })),
  mcpListTimesheets: jest.fn(async () => ({ success: true })),
  mcpListWorkSchedules: jest.fn(async () => ({ success: true })),
  mcpUpdateOvertimeRule: jest.fn(async () => ({ success: true })),
  mcpUpdateTimeEntry: jest.fn(async () => ({ success: true })),
  mcpUpdateWorkSchedule: jest.fn(async () => ({ success: true })),
  mcpListAttendanceRecords: jest.fn(async () => ({ success: true, data: [{ id: 'att-1' }] })),
}));

const attendanceCtl = await import('../../../src/mcp/controllers/attendanceMcpController.js');
const { registerAttendanceTools } = await import('../../../src/mcp/tools/attendanceTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerAttendanceTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_attendance_checkin', ctrl: () => attendanceCtl.mcpCheckIn, gate: 'hr:attendance', action: 'CREATE', args: { employeeId: 7 } },
  { name: 'hr_attendance_checkout', ctrl: () => attendanceCtl.mcpCheckOut, gate: 'hr:attendance', action: 'CREATE', args: { employeeId: 7 } },
  { name: 'hr_attendance_device_connectivity', ctrl: () => attendanceCtl.mcpDeviceConnectivity, gate: 'hr:attendance', action: 'CREATE', args: {}, skipTenantCheck: true },
  { name: 'hr_attendance_device_sync', ctrl: () => attendanceCtl.mcpDeviceSyncAttendance, gate: 'hr:attendance', action: 'CREATE', args: {} },
  { name: 'hr_attendance_daily_summary', ctrl: () => attendanceCtl.mcpAttendanceDailySummary, gate: 'hr:attendance', action: 'VIEW', args: { employeeId: 7 } },
  { name: 'hr_timesheet_submit', ctrl: () => attendanceCtl.mcpCreateTimesheet, gate: 'hr:attendance', action: 'CREATE', args: { employeeId: 7 } },
  { name: 'hr_timesheet_approve', ctrl: () => attendanceCtl.mcpApproveTimesheet, gate: 'hr:attendance', action: 'CREATE', args: { timesheetId: '1' } },
  { name: 'hr_attendance_list', ctrl: () => attendanceCtl.mcpListAttendanceRecords, gate: 'hr:attendance', action: 'VIEW', args: { page: 1, pageSize: 10 } },
  { name: 'hr_attendance_get', ctrl: () => attendanceCtl.mcpGetAttendanceByEmployee, gate: 'hr:attendance', action: 'VIEW', args: { employeeId: 7 } },
  { name: 'hr_time_entry_create', ctrl: () => attendanceCtl.mcpCreateTimeEntry, gate: 'hr:attendance', action: 'CREATE', args: { employeeId: 7 } },
  { name: 'hr_time_entry_update', ctrl: () => attendanceCtl.mcpUpdateTimeEntry, gate: 'hr:attendance', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_time_entry_delete', ctrl: () => attendanceCtl.mcpDeleteTimeEntry, gate: 'hr:attendance', action: 'DELETE', args: { id: 1 } },
  { name: 'hr_work_schedule_create', ctrl: () => attendanceCtl.mcpCreateWorkSchedule, gate: 'hr:attendance', action: 'CREATE', args: { name: 'Morning' } },
  { name: 'hr_work_schedule_update', ctrl: () => attendanceCtl.mcpUpdateWorkSchedule, gate: 'hr:attendance', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_work_schedule_delete', ctrl: () => attendanceCtl.mcpDeleteWorkSchedule, gate: 'hr:attendance', action: 'DELETE', args: { id: 1 } },
  { name: 'hr_overtime_rule_create', ctrl: () => attendanceCtl.mcpCreateOvertimeRule, gate: 'hr:attendance', action: 'CREATE', args: { name: 'Weekend' } },
  { name: 'hr_overtime_rule_update', ctrl: () => attendanceCtl.mcpUpdateOvertimeRule, gate: 'hr:attendance', action: 'EDIT', args: { id: 1 } },
  { name: 'hr_overtime_rule_delete', ctrl: () => attendanceCtl.mcpDeleteOvertimeRule, gate: 'hr:attendance', action: 'DELETE', args: { id: 1 } },
];

describe('ATTENDANCE-SCENARIOS — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, ctrl: ctrlOf, gate, action, args, skipTenantCheck }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to controller with verified tenant', async () => {
    await call(name, args, { permissions: grant });
    expect(ctrlOf()).toHaveBeenCalledTimes(1);
    if (!skipTenantCheck) {
      expect(ctrlOf().mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-A' });
    }
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

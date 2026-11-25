// Month close tools: who may see long absences (HR and Management all, a line manager only their own team, everyone else
// refused), the overview is HR/Management only, a reopen needs a reason, and the submission status shows an ordinary
// employee only whether the month is closed.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/longAbsence.service.js', () => ({
  DEFAULT_MIN_DAYS: 5,
  listLongAbsences: jest.fn(async () => ({ minDays: 5, employees: [] })),
}));
jest.unstable_mockModule('../../../src/services/monthClose.service.js', () => ({ getMonthCloseOverview: jest.fn(async () => ({ month: '2026-10' })) }));
jest.unstable_mockModule('../../../src/lib/actingEmployee.js', () => ({ resolveActingEmployeeId: jest.fn(async ({ user }) => Number(user.employeeId)) }));
jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: { employee: { findMany: jest.fn(async () => [{ id: 11 }, { id: 12 }]) } },
}));
jest.unstable_mockModule('../../../src/services/timesheetSubmission.service.js', () => ({
  getTimesheetSubmissionState: jest.fn(async () => ({ submitted: true, pendingAnomalies: 7, attendanceLocked: true, completeness: { issues: [1, 2] } })),
  submitTimesheet: jest.fn(async () => ({ created: true })),
  unsubmitTimesheet: jest.fn(async () => ({ unsubmitted: true })),
}));

const longAbsence = await import('../../../src/services/longAbsence.service.js');
const closeSvc = await import('../../../src/services/monthClose.service.js');
const sheetSvc = await import('../../../src/services/timesheetSubmission.service.js');
const { registerAttendanceAnomalyTools } = await import('../../../src/mcp/tools/attendanceAnomalyTools.js');
const { registerTimesheetReportTools } = await import('../../../src/mcp/tools/timesheetReportTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const server = { tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]), resource: () => {} };
registerAttendanceAnomalyTools(server);
registerTimesheetReportTools(server);
const USER = { userId: '7', isAdmin: false, employeeId: '7', tenantId: 'tenant-A', email: 'x@dev.invalid' };
const call = (name, args, permissions) => mcpCtx.run({ user: USER, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);
const HR = { 'hr:attendance': ['VIEW', 'EDIT', 'CREATE', 'DELETE', 'EXPORT'] };
const MANAGER = { 'hr:attendance': ['VIEW'], 'hr:approvals:manager': ['VIEW'] };
// What a real request carries: dotted scope strings, with the line-manager grant as a bare code.
const MANAGER_SCOPE = ['hr.attendance.read', 'hr.approvals.manager'];
const EMPLOYEE = { 'hr:attendance': ['VIEW'] };

describe('month close tools', () => {
  beforeEach(() => jest.clearAllMocks());

  it('HR sees every long absence', async () => {
    await call('hr_attendance_long_absence_list', {}, HR);
    expect(longAbsence.listLongAbsences).toHaveBeenCalledWith(expect.not.objectContaining({ employeeIds: expect.anything() }));
  });

  it('a line manager sees only their own team', async () => {
    await call('hr_attendance_long_absence_list', { minDays: 3 }, MANAGER);
    expect(longAbsence.listLongAbsences).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-A', minDays: 3, employeeIds: [11, 12] }));
  });

  it('a line manager is recognised from the real signed scope', async () => {
    await call('hr_attendance_long_absence_list', {}, MANAGER_SCOPE);
    expect(longAbsence.listLongAbsences).toHaveBeenCalledWith(expect.objectContaining({ employeeIds: [11, 12] }));
  });

  it('an ordinary employee is refused, and nothing is read', async () => {
    const res = await call('hr_attendance_long_absence_list', {}, EMPLOYEE);
    expect(res.isError).toBe(true);
    expect(longAbsence.listLongAbsences).not.toHaveBeenCalled();
  });

  it('the overview is for the attendance write grant only', async () => {
    expect((await call('hr_month_close_overview', { month: '2026-10' }, MANAGER)).isError).toBe(true);
    expect((await call('hr_month_close_overview', { month: '2026-10' }, EMPLOYEE)).isError).toBe(true);
    expect(closeSvc.getMonthCloseOverview).not.toHaveBeenCalled();
    await call('hr_month_close_overview', { month: '2026-10' }, HR);
    expect(closeSvc.getMonthCloseOverview).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-A', month: '2026-10' }));
  });

  it('submit and reopen are write-only, and pass the reason on', async () => {
    expect((await call('hr_timesheet_submit', { month: '2026-10' }, EMPLOYEE)).isError).toBe(true);
    expect((await call('hr_timesheet_unsubmit', { month: '2026-10', reason: 'Late fix' }, MANAGER)).isError).toBe(true);
    await call('hr_timesheet_submit', { month: '2026-10', force: true, reason: 'Early' }, HR);
    expect(sheetSvc.submitTimesheet).toHaveBeenCalledWith(expect.objectContaining({ force: true, reason: 'Early' }));
    await call('hr_timesheet_unsubmit', { month: '2026-10', reason: 'Late fix' }, HR);
    expect(sheetSvc.unsubmitTimesheet).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Late fix' }));
  });

  it('the submission status shows an ordinary employee only whether the month is closed', async () => {
    const own = parse(await call('hr_timesheet_submission_status', { month: '2026-10' }, EMPLOYEE));
    expect(own).toEqual({ submitted: true, month: '2026-10' });
    const hr = parse(await call('hr_timesheet_submission_status', { month: '2026-10' }, HR));
    expect(hr.pendingAnomalies).toBe(7);
  });
});

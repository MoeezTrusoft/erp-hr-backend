// Who may call the approval-gated tools: employees file their own swap only; HR files for others; only the holder of
// the exemption grant may file a holiday exemption (holiday write access alone is not enough).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const createShiftSwap = jest.fn(async () => ({ status: 'PENDING' }));
jest.unstable_mockModule('../../../src/services/shiftTemplateSwap.service.js', () => ({
  listShiftTemplates: jest.fn(), createShiftTemplate: jest.fn(), updateShiftTemplate: jest.fn(), deleteShiftTemplate: jest.fn(),
  listShiftSwaps: jest.fn(), createShiftSwap, updateShiftSwap: jest.fn(), decideShiftSwap: jest.fn(), withdrawOvertimeRequest: jest.fn(),
}));
const requestHolidayExemption = jest.fn(async () => ({ status: 'PENDING' }));
const updateHoliday = jest.fn(async () => ({ status: 'PENDING' }));
jest.unstable_mockModule('../../../src/services/holidayChangeRequest.service.js', () => ({
  requestHolidayExemption, listHolidayExemptions: jest.fn(async () => []), listPendingHolidayRequests: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../../src/services/holiday.service.js', () => ({
  getHolidayCalendars: jest.fn(), getHolidayCalendarById: jest.fn(), createHolidayCalendar: jest.fn(), updateHolidayCalendar: jest.fn(),
  deleteHolidayCalendar: jest.fn(), getHolidaysByCalendar: jest.fn(), createHoliday: jest.fn(), updateHoliday, deleteHoliday: jest.fn(),
  getUpcomingHolidays: jest.fn(), getEmployeeHolidays: jest.fn(), assignEmployeeToCalendar: jest.fn(), getEmployeeCalendarAssignments: jest.fn(),
}));
jest.unstable_mockModule('../../../src/services/rosterChangeRequest.service.js', () => ({ listPendingRosterChanges: jest.fn(async () => []) }));
jest.unstable_mockModule('../../../src/services/hrConfigEvents.js', () => ({ emitHolidayCalendarChanged: jest.fn() }));

const { registerShiftTemplateSwapTools } = await import('../../../src/mcp/tools/shiftTemplateSwapTools.js');
const { registerHolidayCalendarTools } = await import('../../../src/mcp/tools/holidayCalendarTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = { tool: (name, ...rest) => handlers.set(name, rest.at(-1)), resource: () => {} };
registerShiftTemplateSwapTools(recording);
registerHolidayCalendarTools(recording);

const user = (employeeId) => ({ userId: '1', isAdmin: false, employeeId, tenantId: 'tenant-A' });
const call = (name, args, { who = user('7'), permissions = {} } = {}) => mcpCtx.run({ user: who, permissions }, () => handlers.get(name)(args));
const status = (res) => JSON.parse(res.content[0].text).status;

beforeEach(() => jest.clearAllMocks());

describe('self-service shift swap', () => {
  it('always files for the signed-in employee, with no grant needed', async () => {
    await call('hr_self_shift_swap_request', { targetCode: 'EMP-2', fromDate: '2026-11-10' });
    expect(createShiftSwap).toHaveBeenCalledWith(expect.objectContaining({ requesterId: 7 }), 'tenant-A', { onBehalf: false });
  });
  it('cannot name someone else: a requesterId in the arguments is ignored', async () => {
    await call('hr_self_shift_swap_request', { requesterId: 99, targetCode: 'EMP-2', fromDate: '2026-11-10' });
    expect(createShiftSwap.mock.calls[0][0].requesterId).toBe(7);
  });
  it('is refused when the login has no employee record', async () => {
    const res = await call('hr_self_shift_swap_request', { targetCode: 'EMP-2', fromDate: '2026-11-10' }, { who: user(undefined) });
    expect(res.isError).toBe(true);
    expect(createShiftSwap).not.toHaveBeenCalled();
  });
});

describe('HR files a swap for someone else', () => {
  it('needs the attendance create grant', async () => {
    const denied = await call('hr_shift_swap_create', { requesterId: 5, targetId: 6, fromDate: '2026-11-10' });
    expect(denied.isError).toBe(true);
    await call('hr_shift_swap_create', { requesterId: 5, targetId: 6, fromDate: '2026-11-10' }, { permissions: { 'hr:attendance': ['CREATE'] } });
    expect(createShiftSwap).toHaveBeenCalledWith(expect.anything(), 'tenant-A', { onBehalf: true });
  });
});

describe('holiday exemption', () => {
  const args = { holidayId: 1, employeeIds: [2], reason: 'Needed on site' };
  it('is refused with only holiday write access', async () => {
    const res = await call('hr_holiday_exemption_request', args, { permissions: { 'hr:holiday': ['CREATE', 'EDIT', 'DELETE'] } });
    expect(res.isError).toBe(true);
    expect(requestHolidayExemption).not.toHaveBeenCalled();
  });
  it('is allowed for the holder of the exemption grant', async () => {
    const res = await call('hr_holiday_exemption_request', args, { permissions: { 'hr:holiday_exempt': ['CREATE'] } });
    expect(status(res)).toBe('PENDING');
    expect(requestHolidayExemption).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-A', requestedById: '7', holidayId: 1 }));
  });
});

describe('moving a holiday', () => {
  it('carries newDate to the request as the new date, and leaves it out when not moving', async () => {
    const grant = { permissions: { 'hr:holiday': ['EDIT'] } };
    await call('hr_holiday_update', { calendarId: 1, date: '2026-11-03', newDate: '2026-11-04', reason: 'Moved' }, grant);
    expect(updateHoliday).toHaveBeenLastCalledWith(1, '2026-11-03', { reason: 'Moved', date: '2026-11-04' }, '7');
    await call('hr_holiday_update', { calendarId: 1, date: '2026-11-03', name: 'Renamed', reason: 'Typo' }, grant);
    expect(updateHoliday).toHaveBeenLastCalledWith(1, '2026-11-03', { name: 'Renamed', reason: 'Typo' }, '7');
  });
});

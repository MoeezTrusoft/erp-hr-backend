// HR-OT-SCOPE-01 — hr:attendance VIEW (held by every employee) shows an employee
// their own overtime, never a colleague's; company-wide overtime is an HR view.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/overtimeShift.service.js', () => ({
  getOvertimeShiftOverview: jest.fn(async () => ({})),
  getShiftScheduleWeek: jest.fn(async () => ({})),
  listOvertimeHistory: jest.fn(async () => ({ items: [] })),
}));
jest.unstable_mockModule('../../src/services/overtimeApproval.service.js', () => ({
  createOvertimeRequest: jest.fn(async () => ({ submitted: true })),
  decideOvertimeRequest: jest.fn(),
}));

const svc = await import('../../src/services/overtimeShift.service.js');
const otApproval = await import('../../src/services/overtimeApproval.service.js');
const { registerOvertimeShiftTools } = await import('../../src/mcp/tools/overtimeShiftTools.js');
const { mcpCtx } = await import('../../src/mcp/context.js');

const handlers = new Map();
registerOvertimeShiftTools({ tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]), resource: () => {} });
const USER = { userId: '3', employeeId: '7', tenantId: 't1', isAdmin: false };
const EMPLOYEE = { 'hr:attendance': ['VIEW'] };
const HR = { 'hr:attendance': ['VIEW', 'EDIT'] };
const call = (name, args, permissions, user = USER) =>
  mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe.each([
  ['hr_overtime_history_list', () => svc.listOvertimeHistory],
  ['hr_overtime_shift_overview', () => svc.getOvertimeShiftOverview],
  ['hr_shift_schedule_week', () => svc.getShiftScheduleWeek],
])('%s', (name, fn) => {
  it('an employee is pinned to their own rows', async () => {
    await call(name, {}, EMPLOYEE);
    expect(fn().mock.calls[0][0].employeeId).toBe(7);
  });
  it("asking for someone else is refused", async () => {
    const res = await call(name, { employeeId: 2 }, EMPLOYEE);
    expect(parse(res).status).toBe(403);
    expect(fn()).not.toHaveBeenCalled();
  });
  it('HR sees the company (or the person asked for)', async () => {
    await call(name, {}, HR);
    expect(fn().mock.calls[0][0].employeeId).toBeUndefined();
  });
});

describe('hr_overtime_request_mine (HR-OT-SELF-01)', () => {
  it('files for the signed-in employee only, and submits it', async () => {
    await call('hr_overtime_request_mine', { date: '2026-11-24', hours: 2, reason: 'month-end close' }, EMPLOYEE);
    expect(otApproval.createOvertimeRequest).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7, submit: 'self', tenantId: 't1' }));
  });
  it('needs an employee account', async () => {
    const res = await call('hr_overtime_request_mine', { date: '2026-11-24', hours: 2, reason: 'xyz' }, EMPLOYEE, { ...USER, employeeId: null });
    expect(parse(res).status).toBe(403);
  });
  it('HR filing for someone submits on their behalf', async () => {
    await call('hr_overtime_request_create', { employeeId: 9, date: '2026-11-24', hours: 2, reason: 'cover' }, { 'hr:attendance': ['VIEW', 'CREATE'] });
    expect(otApproval.createOvertimeRequest).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 9, submit: 'onBehalf' }));
  });
});

describe('company overtime figures (assertSeesTeamOvertime)', () => {
  it('refuses the VIEW every employee holds and allows HR', async () => {
    const { assertSeesTeamOvertime } = await import('../../src/mcp/utils/actorScope.js');
    expect(() => assertSeesTeamOvertime(USER, EMPLOYEE)).toThrow(/HR view/);
    expect(() => assertSeesTeamOvertime(USER, HR)).not.toThrow();
    expect(() => assertSeesTeamOvertime(USER, { 'hr:attendance_all': ['VIEW'] })).not.toThrow();
  });
});

// The tools that file attendance rule changes, and the capture clock fix, are refused without their grants, never
// reach their service on a refusal, and an administrator flag alone grants nothing.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/attendanceRuleChangeRequest.service.js', () => ({
  requestGraceRule: jest.fn(async () => ({ pendingApproval: true })),
  requestGraceMembership: jest.fn(async () => ({ pendingApproval: true })),
  requestAttendanceSetupPublish: jest.fn(async () => ({ pendingApproval: true })),
  listPendingRuleChanges: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../../src/services/attendanceDeviceCommand.service.js', () => ({
  requestClockFix: jest.fn(async () => ({ state: 'PENDING' })),
  listClockCommands: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../../src/services/approval/legacy.js', () => ({
  legacySubmit: jest.fn(async () => ({ ok: true })),
  legacyDecision: jest.fn(), legacyWithdraw: jest.fn(),
}));

const changes = await import('../../../src/services/attendanceRuleChangeRequest.service.js');
const commands = await import('../../../src/services/attendanceDeviceCommand.service.js');
const legacy = await import('../../../src/services/approval/legacy.js');
const { registerAttendanceRulesTools } = await import('../../../src/mcp/tools/attendanceRulesTools.js');
const { registerAttendanceCaptureTools } = await import('../../../src/mcp/tools/attendanceCaptureTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = { tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]), resource: () => {} };
registerAttendanceRulesTools(recording);
registerAttendanceCaptureTools(recording);

const USER = { userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'], isAdmin: false, employeeId: '7', tenantId: 'tenant-A' };
const call = (name, args, { user = USER, permissions = {} } = {}) => mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
const parse = (res) => JSON.parse(res.content[0].text);
const grace = { scope: 'COMPANY', scopeKey: '*', effectiveFrom: '2026-12-01', checkInMinutes: 10, checkOutMinutes: 5, version: -1, reason: 'Gate queues' };

beforeEach(() => jest.clearAllMocks());

describe('grace and team assignment changes are requests that need the attendance write grant', () => {
  for (const [name, args, fn] of [
    ['hr_attendance_rules_grace_save', grace, () => changes.requestGraceRule],
    ['hr_attendance_rules_membership_save', { employeeId: 3, effectiveFrom: '2026-12-01', teamKey: 'Night', departmentKey: null, version: -1, reason: 'Move' }, () => changes.requestGraceMembership],
  ]) {
    it(`${name}: a read-only grant is refused (403) and nothing is filed`, async () => {
      const res = await call(name, args, { permissions: { 'hr:attendance': ['GET'] } });
      expect(res.isError).toBe(true);
      expect(parse(res).status).toBe(403);
      expect(fn()).not.toHaveBeenCalled();
    });
    it(`${name}: no grants and a forged isAdmin flag are refused`, async () => {
      for (const user of [USER, { ...USER, isAdmin: true }]) {
        const res = await call(name, args, { user, permissions: {} });
        expect(res.isError).toBe(true);
        expect(parse(res).status).toBe(403);
      }
      expect(fn()).not.toHaveBeenCalled();
    });
    it(`${name}: the write grant files it for the verified company and filer`, async () => {
      await call(name, args, { permissions: { 'hr:attendance': ['CREATE'] } });
      expect(fn()).toHaveBeenCalledTimes(1);
      expect(fn().mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-A', requestedById: '7' });
    });
  }
});

describe('what an employee may read, and what filing a correction for someone needs', () => {
  it('the employee reads their own grace limits without any attendance grant', async () => {
    // Whatever the service answers, the permission gate itself must not refuse an employee with no attendance grant.
    const res = await call('hr_attendance_rules_mine', {}, { permissions: {} });
    if (res.isError) expect(parse(res).code).not.toBe('HR-4030');
  });
  it('submitting a correction for an employee leaves the who-may-file decision to the approval service', async () => {
    await call('hr_attendance_rules_correction_submit_on_behalf', { id: '11111111-1111-4111-8111-111111111111', reason: 'Raised for them' }, { permissions: {} });
    expect(legacy.legacySubmit).toHaveBeenCalledWith('ATTENDANCE_CORRECTION', '11111111-1111-4111-8111-111111111111', 'Raised for them', { onBehalf: true, managerMayFile: true });
  });
  it('the pending list of rule changes needs the attendance read grant', async () => {
    const res = await call('hr_attendance_rules_rule_changes_pending', {}, { permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
    expect(changes.listPendingRuleChanges).not.toHaveBeenCalled();
  });
});

describe('the machine clock fix is an attendance operation', () => {
  it('is refused without the grant and files for the verified company with it', async () => {
    const denied = await call('hr_attendance_device_clock_fix', { sn: 'GATE-1' }, { permissions: {} });
    expect(denied.isError).toBe(true);
    expect(parse(denied).status).toBe(403);
    expect(commands.requestClockFix).not.toHaveBeenCalled();
    await call('hr_attendance_device_clock_fix', { sn: 'GATE-1' }, { permissions: { 'hr:attendance': ['EDIT', 'CREATE', 'VIEW'] } });
    expect(commands.requestClockFix.mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-A', sn: 'GATE-1' });
  });
});

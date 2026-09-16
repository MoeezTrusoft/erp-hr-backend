// tests/unit/mcp/selfRaise.anomaly.tools.scenarios.test.js
//
// HR-ANOM-DEADLINE-02 — the self-service raise (hr_attendance_anomaly_create)
// was gated on hr:attendance CREATE, a permission regular employees don't
// hold: the "Request fix" form every employee is supposed to use returned 403
// before the deadline logic could even run (found live 2026-09-17 raising a
// test anomaly as an employee). The tool is strictly self-scoped — applicant
// from the verified JWT, category/times re-derived server-side, deadline +
// duplicate-PENDING + period guards in the service — so it now accepts
// VIEW-or-CREATE. Every OTHER attendance write must keep its strict gate.
// DB-free: services mocked; gate + dispatch asserted (same pattern as
// attendanceOps.anomaly.tools.scenarios.test.js).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/attendanceAnomalyRequest.service.js', () => ({
  getAnomalyFormDefaults: jest.fn(async () => ({ category: 'LATE_CHECKIN' })),
  createAnomalyRequest: jest.fn(async () => ({ id: 9001, status: 'PENDING', requestDeadline: '2026-09-17T23:59:59.000Z' })),
}));
jest.unstable_mockModule('../../../src/services/dayWorkMode.service.js', () => ({
  setDayWorkMode: jest.fn(async () => ({ ok: true })),
  getDayWorkMode: jest.fn(async () => ({ workMode: 'Onsite' })),
}));
jest.unstable_mockModule('../../../src/services/attendanceCorrection.service.js', () => ({
  correctAttendanceDay: jest.fn(async () => ({ ok: true })),
  listCorrections: jest.fn(async () => ({ items: [] })),
}));
jest.unstable_mockModule('../../../src/services/absenceMarking.service.js', () => ({
  markAbsences: jest.fn(async () => ({ marked: 0 })),
}));
jest.unstable_mockModule('../../../src/services/overtimeApproval.service.js', () => ({
  listOvertimeForApprover: jest.fn(async () => []),
  resolveOvertimeChain: jest.fn(async () => ({ levels: [] })),
  detectOvertimeFromPunches: jest.fn(async () => ({ detected: 0 })),
}));
jest.unstable_mockModule('../../../src/services/attendanceAnomalyRouting.service.js', () => ({
  resolveApprovalChain: jest.fn(async () => ({ levels: [] })),
  decideAnomaly: jest.fn(async () => ({ id: 1, status: 'APPROVED' })),
  listPendingForApprover: jest.fn(async () => []),
}));

const { registerAttendanceAnomalyTools } = await import('../../../src/mcp/tools/attendanceAnomalyTools.js');
const requestSvc = await import('../../../src/services/attendanceAnomalyRequest.service.js');
const correctionSvc = await import('../../../src/services/attendanceCorrection.service.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerAttendanceAnomalyTools(recording);

// A regular employee: VIEW on attendance, nothing else. No admin flag.
const EMPLOYEE = {
  userId: '481', email: 'huzaifa@trusoft.pk', roles: ['EMPLOYEE'],
  isAdmin: false, employeeId: '481', tenantId: 'tenant-A',
};
const VIEW_ONLY = { 'hr:attendance': ['VIEW'] };
const CREATE_ONLY = { 'hr:attendance': ['CREATE'] };

function call(name, args, { user = EMPLOYEE, permissions = VIEW_ONLY } = {}) {
  return mcpCtx.run({ user, permissions }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const ARGS = { date: '2026-09-17', reason: 'traffic on the way in' };

describe('SELF-RAISE — hr_attendance_anomaly_create gate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('employee with ONLY hr:attendance VIEW can raise a request for themselves', async () => {
    const res = await call('hr_attendance_anomaly_create', ARGS);
    expect(res.isError).toBeUndefined();
    expect(parse(res).id).toBe(9001);
    // Applicant is the verified session employee, never an argument.
    expect(requestSvc.createAnomalyRequest).toHaveBeenCalledTimes(1);
    expect(requestSvc.createAnomalyRequest.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-A',
      employeeId: 481, // actingEmployeeId coerces the verified claim to a number
      date: '2026-09-17',
      reason: 'traffic on the way in',
    });
  });

  it('HR holding CREATE also passes (gate is VIEW-or-CREATE)', async () => {
    const res = await call('hr_attendance_anomaly_create', ARGS, { permissions: CREATE_ONLY });
    expect(res.isError).toBeUndefined();
    expect(requestSvc.createAnomalyRequest).toHaveBeenCalledTimes(1);
  });

  it('deny-by-default: an empty permission blob is still 403, service untouched', async () => {
    const res = await call('hr_attendance_anomaly_create', ARGS, { permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
    expect(requestSvc.createAnomalyRequest).not.toHaveBeenCalled();
  });

  it('forged isAdmin grants nothing without permissions', async () => {
    const res = await call('hr_attendance_anomaly_create', ARGS, {
      user: { ...EMPLOYEE, isAdmin: true },
      permissions: {},
    });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });

  it('a login with no bound employee is 403 before any write (actingEmployeeId guard)', async () => {
    const res = await call('hr_attendance_anomaly_create', ARGS, {
      user: { ...EMPLOYEE, employeeId: null },
    });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
    expect(requestSvc.createAnomalyRequest).not.toHaveBeenCalled();
  });

  it('form defaults (GET) work for the VIEW-only employee — the modal prefills', async () => {
    const res = await call('hr_attendance_anomaly_form_defaults', { date: '2026-09-17' });
    expect(res.isError).toBeUndefined();
    expect(requestSvc.getAnomalyFormDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-A', employeeId: 481 }),
    );
  });
});

describe('SELF-RAISE — the relaxation does NOT leak to other writes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('hr_attendance_correct_day still rejects a VIEW-only employee (HR/admin only)', async () => {
    const res = await call('hr_attendance_correct_day', {
      employeeId: 481, date: '2026-09-17', checkIn: '09:00', reason: 'test',
    });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
    expect(correctionSvc.correctAttendanceDay).not.toHaveBeenCalled();
  });

  it('hr_attendance_correct_day still works for CREATE holders (HR role unchanged)', async () => {
    const res = await call('hr_attendance_correct_day', {
      employeeId: 481, date: '2026-09-17', checkIn: '09:00', reason: 'test',
    }, { permissions: { 'hr:attendance': ['VIEW', 'CREATE', 'EDIT'] } });
    expect(res.isError).toBeUndefined();
    expect(correctionSvc.correctAttendanceDay).toHaveBeenCalledTimes(1);
  });
});

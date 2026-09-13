// tests/unit/mcp/attendanceOps.anomaly.tools.scenarios.test.js
//
// T-FIX (Phase D) — hr_anomaly_create was promised by the frontend manifest and
// served by hr-mock.js, but never registered server-side: a manifest write was
// a guaranteed tool-not-found at the gateway. Pins the whole anomaly ops
// surface (inform/create/list/decide): registration, dispatch, permission gate.
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/attendanceAnomaly.service.js', () => ({
  informAbnormality: jest.fn(async () => ({ id: 1, status: 'PENDING' })),
  listAnomalies: jest.fn(async () => ({ items: [], total: 0 })),
  decideAnomaly: jest.fn(async () => ({ id: 1, status: 'APPROVED' })),
}));
jest.unstable_mockModule('../../../src/services/pendingApprovals.service.js', () => ({
  listPendingApprovals: jest.fn(async () => []),
  decidePendingApproval: jest.fn(async () => ({ ok: true })),
}));

const { registerAttendanceOpsTools } = await import('../../../src/mcp/tools/attendanceOpsTools.js');
const anomalySvc = await import('../../../src/services/attendanceAnomaly.service.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerAttendanceOpsTools(recording);

const USER = {
  userId: '7', email: 'hr@acme.test', roles: ['HR_ADMIN'],
  isAdmin: false, employeeId: '7', tenantId: 'tenant-A',
};

function call(name, args, { user = USER, permissions } = {}) {
  return mcpCtx.run({ user, permissions: permissions || {} }, () => handlers.get(name)(args));
}
const parse = (res) => JSON.parse(res.content[0].text);

const TOOLS = [
  { name: 'hr_anomaly_inform', svc: () => anomalySvc.informAbnormality, gate: 'hr:attendance', action: 'CREATE', args: { type: 'LATE_CHECKIN' } },
  { name: 'hr_anomaly_create', svc: () => anomalySvc.informAbnormality, gate: 'hr:attendance', action: 'CREATE', args: { type: 'MISSING_CHECKIN', reason: 'forgot badge' } },
  { name: 'hr_anomaly_list', svc: () => anomalySvc.listAnomalies, gate: 'hr:attendance', action: 'VIEW', args: {} },
  { name: 'hr_anomaly_decide', svc: () => anomalySvc.decideAnomaly, gate: 'hr:attendance', action: 'EDIT', args: { id: 1, decision: 'approve' } },
];

describe('ATTENDANCE-OPS-ANOMALY — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

describe.each(TOOLS)('$name scenarios', ({ name, svc: svcOf, gate, action, args }) => {
  const grant = { [gate]: [action] };

  beforeEach(() => jest.clearAllMocks());

  it('happy path: dispatches to the service with the verified tenant', async () => {
    const res = await call(name, args, { permissions: grant });
    expect(res).toBeDefined();
    expect(res.content[0].type).toBe('text');
    expect(svcOf()).toHaveBeenCalledTimes(1);
    expect(svcOf().mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-A' });
  });

  it('deny-by-default: no permission blob -> 403, service untouched', async () => {
    const res = await call(name, args, { permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
    expect(svcOf()).not.toHaveBeenCalled();
  });

  it('forged isAdmin grants nothing (still 403)', async () => {
    const res = await call(name, args, { user: { ...USER, isAdmin: true }, permissions: {} });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
    expect(svcOf()).not.toHaveBeenCalled();
  });
});

describe('hr_anomaly_create specifics', () => {
  beforeEach(() => jest.clearAllMocks());

  it('defaults employeeId to the caller', async () => {
    await call('hr_anomaly_create', { type: 'OTHER', detail: 'traffic' }, {
      permissions: { 'hr:attendance': ['CREATE'] },
    });
    expect(anomalySvc.informAbnormality.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-A',
      employeeId: '7',
      type: 'OTHER',
      detail: 'traffic',
    });
  });

  it('400 when no employeeId anywhere (no session employee either)', async () => {
    const res = await call('hr_anomaly_create', { type: 'LATE_CHECKIN' }, {
      user: { ...USER, employeeId: undefined },
      permissions: { 'hr:attendance': ['CREATE'] },
    });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(400);
  });

  it('honors an explicit employeeId (HR raising on behalf of an employee)', async () => {
    await call('hr_anomaly_create', { employeeId: 42, type: 'ABSENT' }, {
      permissions: { 'hr:attendance': ['CREATE'] },
    });
    expect(anomalySvc.informAbnormality.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-A',
      employeeId: 42,
      type: 'ABSENT',
    });
  });
});

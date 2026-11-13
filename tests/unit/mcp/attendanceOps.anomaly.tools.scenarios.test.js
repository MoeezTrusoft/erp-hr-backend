// tests/unit/mcp/attendanceOps.anomaly.tools.scenarios.test.js
//
// T-FIX (Phase D) — hr_anomaly_create was promised by the frontend manifest and
// served by hr-mock.js, but never registered server-side: a manifest write was
// a guaranteed tool-not-found at the gateway. Pins the whole anomaly ops
// surface (inform/create/list/decide): registration, dispatch, permission gate.
// DB-free: services are mocked; tool→service dispatch + gate is asserted.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { z } from 'zod';

jest.unstable_mockModule('../../../src/services/attendanceAnomaly.service.js', () => ({
  informAbnormality: jest.fn(async () => ({ id: 1, status: 'PENDING' })),
  listAnomalies: jest.fn(async () => ({ items: [], total: 0 })),
  decideAnomaly: jest.fn(async () => ({ id: 1, status: 'APPROVED' })),
  // TS-ANOM-EDIT-01 — the edit tool must be pinned by the same registration /
  // dispatch / permission-gate matrix as the rest of the anomaly surface.
  updateAnomaly: jest.fn(async () => ({ id: 1, status: 'PENDING' })),
  // TS-ANOM-DELETE-01/2 — the withdraw tool joins the same matrix. The tool
  // gate is DELETE hr:attendance (Admin/HR Manager only); passing it tells
  // the service requesterCanDeleteAny=true, so HR/admin may withdraw any
  // pending request (2026-10-09 operator ruling).
  deleteAnomaly: jest.fn(async () => ({ id: 1, status: 'DELETED' })),
}));
jest.unstable_mockModule('../../../src/services/pendingApprovals.service.js', () => ({
  listPendingApprovals: jest.fn(async () => []),
  decidePendingApproval: jest.fn(async () => ({ ok: true })),
}));

const { registerAttendanceOpsTools } = await import('../../../src/mcp/tools/attendanceOpsTools.js');
const anomalySvc = await import('../../../src/services/attendanceAnomaly.service.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const schemas = new Map();
const recording = {
  tool: (name, ...rest) => {
    handlers.set(name, rest[rest.length - 1]);
    // The zod schema lands immediately before the callback (tool name,
    // description, schema, cb) — grab it for argument-contract tests.
    const cb = rest[rest.length - 1];
    const schemaArg = rest[rest.length - 2];
    if (schemaArg && typeof schemaArg === 'object' && typeof cb === 'function') {
      schemas.set(name, schemaArg);
    }
  },
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
  { name: 'hr_anomaly_inform', svc: () => anomalySvc.informAbnormality, gate: 'hr:attendance', action: 'CREATE', args: { reason: 'late arrival', date: '2026-09-17' } },
  { name: 'hr_anomaly_create', svc: () => anomalySvc.informAbnormality, gate: 'hr:attendance', action: 'CREATE', args: { reason: 'forgot badge', date: '2026-09-17' } },
  { name: 'hr_anomaly_list', svc: () => anomalySvc.listAnomalies, gate: 'hr:attendance', action: 'VIEW', args: {} },
  { name: 'hr_anomaly_decide', svc: () => anomalySvc.decideAnomaly, gate: 'hr:attendance', action: 'EDIT', args: { id: 1, decision: 'approve' } },
  // TS-ANOM-EDIT-01 — PUT hr:attendance, same gate class as decide.
  { name: 'hr_anomaly_update', svc: () => anomalySvc.updateAnomaly, gate: 'hr:attendance', action: 'EDIT', args: { id: 1, reason: 'edited' } },
  // TS-ANOM-DELETE-01/2 — DELETE hr:attendance (withdraw). The gate pass is
  // the whole who-may-delete rule for this edge; see specifics below.
  { name: 'hr_anomaly_delete', svc: () => anomalySvc.deleteAnomaly, gate: 'hr:attendance', action: 'DELETE', args: { id: 1 } },
];

describe('ATTENDANCE-OPS-ANOMALY — registration', () => {
  it.each(TOOLS.map((t) => t.name))('%s is registered', (name) => {
    expect(handlers.has(name)).toBe(true);
  });
});

// Type and affected date are intentionally absent from the backend edit
// schema; callers may change explanatory text and time details only.
describe('hr_anomaly_update argument contract', () => {
  it('accepts nullable editable fields but exposes no type/date inputs', () => {
    const shape = schemas.get('hr_anomaly_update');
    expect(shape).toBeDefined();
    expect(shape).not.toHaveProperty('type');
    expect(shape).not.toHaveProperty('date');
    const schema = z.object(shape);
    const probe = schema.safeParse({ id: 1260, reason: null, detail: null, fromTime: null, toTime: null });
    expect(probe.success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
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

  it('defaults employeeId to the caller and does not forward a client type', async () => {
    await call('hr_anomaly_create', { type: 'OTHER', date: '2026-09-17', reason: 'traffic' }, {
      permissions: { 'hr:attendance': ['CREATE'] },
    });
    expect(anomalySvc.informAbnormality.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-A',
      employeeId: '7',
      date: '2026-09-17',
      reason: 'traffic',
    });
    expect(anomalySvc.informAbnormality.mock.calls[0][0]).not.toHaveProperty('type');
  });

  it('400 when no employeeId anywhere (no session employee either)', async () => {
    const res = await call('hr_anomaly_create', { type: 'LATE_CHECKIN' }, {
      user: { ...USER, employeeId: undefined },
      permissions: { 'hr:attendance': ['CREATE'] },
    });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(400);
  });

  it('honors an explicit employeeId without accepting its requested type', async () => {
    await call('hr_anomaly_create', { employeeId: 42, type: 'ABSENT', date: '2026-09-17' }, {
      permissions: { 'hr:attendance': ['CREATE'] },
    });
    expect(anomalySvc.informAbnormality.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-A',
      employeeId: 42,
      date: '2026-09-17',
    });
    expect(anomalySvc.informAbnormality.mock.calls[0][0]).not.toHaveProperty('type');
  });
});

describe('hr_anomaly_delete specifics (TS-ANOM-DELETE-01/2)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('tells the service requesterCanDeleteAny after the edge gate passes — HR/admin withdraws any pending request', async () => {
    await call('hr_anomaly_delete', { id: 1 }, { permissions: { 'hr:attendance': ['DELETE'] } });
    expect(anomalySvc.deleteAnomaly.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-A',
      id: 1,
      requesterEmployeeId: '7',
      requesterCanDeleteAny: true,
    });
  });

  it('without the DELETE grant the service is never called (so no privileged bypass can leak)', async () => {
    const res = await call('hr_anomaly_delete', { id: 1 }, { permissions: { 'hr:attendance': ['EDIT'] } });
    expect(res.isError).toBe(true);
    expect(anomalySvc.deleteAnomaly).not.toHaveBeenCalled();
  });
});

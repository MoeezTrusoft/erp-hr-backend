// tests/unit/mcp/positionMgmt.export.tools.test.js
//
// hr_positions_export is ELEVATED (2026-10-13): it requires hr:employee VIEW
// **and** EXPORT, the same rule as hr_employees_export /
// hr_employee_login_password_get. VIEW opens the Position Management screen;
// EXPORT is the atom that authorises taking a bulk copy of the tenant's
// position data out of the platform.
//
// DB-free: the service is mocked and the tool is driven through the real
// permission layer (mcpCtx), so the assertions are about the gate itself —
// happy-path dispatch is proven by the returned body (see the note in
// employee.tools.scenarios.test.js about mock-instance identity under
// jest.unstable_mockModule).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/positionMgmt.service.js', () => ({
  listManagedPositions: jest.fn(async () => ({ success: true, items: [] })),
  getManagedPosition: jest.fn(async () => ({ success: true })),
  exportManagedPositions: jest.fn(async () => ({ success: true, base64: 'bW9jaw==' })),
}));

const { registerPositionMgmtTools } = await import('../../../src/mcp/tools/positionMgmtTools.js');
const { mcpCtx } = await import('../../../src/mcp/context.js');

const handlers = new Map();
const recording = {
  tool: (name, ...rest) => handlers.set(name, rest[rest.length - 1]),
  resource: () => {},
};
registerPositionMgmtTools(recording);

const USER = {
  userId: '7',
  email: 'hr@acme.test',
  roles: ['HR_ADMIN'],
  isAdmin: false,
  employeeId: '7',
  tenantId: 'tenant-A',
};

const call = (args, permissions) =>
  mcpCtx.run({ user: USER, permissions }, () => handlers.get('hr_positions_export')(args));
const parse = (res) => JSON.parse(res.content[0].text);

describe('hr_positions_export — VIEW + EXPORT elevation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is registered', () => {
    expect(handlers.has('hr_positions_export')).toBe(true);
  });

  it('deny-by-default: no permission blob -> 403', async () => {
    const res = await call({}, {});
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });

  it('VIEW alone is not enough -> 403', async () => {
    const res = await call({}, { 'hr:employee': ['VIEW'] });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });

  it('EXPORT without VIEW -> 403 (the base assert still runs first)', async () => {
    const res = await call({}, { 'hr:employee': ['EXPORT'] });
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });

  it('forged isAdmin grants nothing (still 403)', async () => {
    const res = await mcpCtx.run(
      { user: { ...USER, isAdmin: true }, permissions: {} },
      () => handlers.get('hr_positions_export')({})
    );
    expect(res.isError).toBe(true);
    expect(parse(res).status).toBe(403);
  });

  it('VIEW + EXPORT dispatches to the export service', async () => {
    const res = await call({}, { 'hr:employee': ['VIEW', 'EXPORT'] });
    expect(res.isError).toBeUndefined();
    expect(parse(res).success).toBe(true);
  });
});

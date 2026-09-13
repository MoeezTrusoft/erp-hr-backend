// tests/unit/controllers/workSchedule.controller.tenant-thread.test.js
//
// T-FIX (Phase C) — the work-schedule controllers dropped the verified tenant
// on update/delete (service got no tenantId → scopedWhere(undefined) = NO
// tenant filter), so the MCP facade that wraps these controllers inherited the
// same fail-open hole. They also required an Employee actor unconditionally,
// which locked out HR/admin callers without a linked Employee row.
//
// Pins: verified-tenant threading, body-tenantId stripping, and admin tolerance.
// DB-free: the service and prisma are mocked; controllers run real.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../../src/services/workScheduleService.js', () => ({
  getWorkSchedules: jest.fn(async () => []),
  createWorkSchedule: jest.fn(async () => ({ id: 1 })),
  updateWorkSchedule: jest.fn(async () => ({ id: 1 })),
  deleteWorkSchedule: jest.fn(async () => ({ id: 1 })),
}));
// requireEmployeeActor falls back to an email lookup through prisma when the
// JWT carries no employeeId — give it "not found" so the actor path throws and
// the controller's tolerance (.catch(() => null)) is what's under test.
jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: { employee: { findFirst: jest.fn(async () => null) } },
}));

const service = await import('../../../src/services/workScheduleService.js');
const controller = await import('../../../src/controllers/workScheduleController.js');

const USER = {
  userId: 5,
  employeeId: 7,
  email: 'hr@acme.test',
  role: 'HR_ADMIN',
  roles: ['HR_ADMIN'],
  isAdmin: false,
  tenantId: 'tenant-A',
};

const resMock = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

beforeEach(() => jest.clearAllMocks());

describe('workScheduleController — verified tenant threading', () => {
  it('update: strips body tenantId and threads the verified one', async () => {
    await controller.updateWorkSchedule(
      { params: { id: '1' }, body: { schedule_name: 'X', tenantId: 'spoofed-tenant' }, user: USER },
      resMock(),
    );

    expect(service.updateWorkSchedule).toHaveBeenCalledTimes(1);
    const [id, body, actor, tenantId] = service.updateWorkSchedule.mock.calls[0];
    expect(id).toBe('1');
    expect(body).toEqual({ schedule_name: 'X' });
    expect(body).not.toHaveProperty('tenantId');
    expect(tenantId).toBe('tenant-A');
  });

  it('delete: threads the verified tenant', async () => {
    await controller.deleteWorkSchedule(
      { params: { id: '1' }, body: {}, user: USER },
      resMock(),
    );

    expect(service.deleteWorkSchedule).toHaveBeenCalledWith('1', 7, 'tenant-A');
  });

  it('create: verified tenant wins over a spoofed body tenantId', async () => {
    await controller.createWorkSchedule(
      { params: {}, body: { employeeId: 9, schedule_name: 'N', tenantId: 'spoofed-tenant' }, user: USER },
      resMock(),
    );

    const arg = service.createWorkSchedule.mock.calls[0][0];
    expect(arg.tenantId).toBe('tenant-A');
    expect(arg.employeeId).toBe(9);
  });

  it('update/delete tolerate a caller without a linked Employee row (actor null, not 403)', async () => {
    const adminNoEmployee = { ...USER, employeeId: undefined, email: 'admin@acme.test' };

    await controller.updateWorkSchedule(
      { params: { id: '1' }, body: { schedule_name: 'X' }, user: adminNoEmployee },
      resMock(),
    );
    expect(service.updateWorkSchedule).toHaveBeenCalled();

    await controller.deleteWorkSchedule(
      { params: { id: '1' }, body: {}, user: adminNoEmployee },
      resMock(),
    );
    expect(service.deleteWorkSchedule).toHaveBeenCalled();

    const actor = service.updateWorkSchedule.mock.calls[0][2];
    expect(actor).toBeNull();
  });
});

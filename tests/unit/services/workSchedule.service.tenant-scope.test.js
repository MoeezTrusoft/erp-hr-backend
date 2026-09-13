// tests/unit/services/workSchedule.service.tenant-scope.test.js
//
// T-FIX (Phase C) — work-schedule write paths were tenant fail-open:
// the REST controllers dropped the verified tenant on update/delete, so
// scopedWhere(undefined) applied NO tenant filter and a bare id could mutate
// another tenant's roster — which day-derivation turns into absences, lates
// and a wrong payslip. Update also spread `...data`, letting a body overwrite
// employeeId/tenantId. These tests pin the closures.
//
// DB-free: prisma and logAction are mocked at the module seam; the service
// runs real.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const prisma = {
  workSchedule: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  overtimeRule: { findFirst: jest.fn(), findUnique: jest.fn() },
  employee: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({ default: prisma }));
jest.unstable_mockModule('../../../src/utils/logs.js', () => ({ logAction: jest.fn(async () => {}) }));

const service = await import('../../../src/services/workScheduleService.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('workScheduleService.updateWorkSchedule — tenant scoping', () => {
  it('resolves the row WITH the verified tenant scope', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce({ id: 1, employeeId: 7 });
    prisma.workSchedule.update.mockResolvedValueOnce({ id: 1, schedule_name: 'X' });

    await service.updateWorkSchedule(1, { schedule_name: 'X' }, 7, 'tenant-A');

    expect(prisma.workSchedule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 1, tenantId: 'tenant-A' }),
      }),
    );
  });

  it('refuses a row that exists only in another tenant (404, no write)', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.updateWorkSchedule(1, { schedule_name: 'X' }, 7, 'tenant-A'),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.workSchedule.update).not.toHaveBeenCalled();
  });

  it('ignores caller-supplied employeeId/tenantId (field allowlist)', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce({ id: 1, employeeId: 7 });
    prisma.workSchedule.update.mockResolvedValueOnce({ id: 1 });

    await service.updateWorkSchedule(
      1,
      { schedule_name: 'Y', employeeId: 999, tenantId: 'tenant-B' },
      7,
      'tenant-A',
    );

    const data = prisma.workSchedule.update.mock.calls[0][0].data;
    expect(data.schedule_name).toBe('Y');
    expect(data).not.toHaveProperty('employeeId');
    expect(data).not.toHaveProperty('tenantId');
  });

  it('validates a nonsense pattern instead of storing it', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce({ id: 1, employeeId: 7 });

    await expect(
      service.updateWorkSchedule(1, { schedule_pattern: { offDays: [8], shift: { from: '9', to: '17' } } }, 7, 'tenant-A'),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.workSchedule.update).not.toHaveBeenCalled();
  });
});

describe('workScheduleService.deleteWorkSchedule — tenant scoping', () => {
  it('resolves the row WITH the verified tenant scope', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce({ id: 2 });
    prisma.workSchedule.delete.mockResolvedValueOnce({ id: 2 });

    await service.deleteWorkSchedule(2, 7, 'tenant-A');

    expect(prisma.workSchedule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 2, tenantId: 'tenant-A' }),
      }),
    );
  });

  it('refuses a cross-tenant delete (404, no write)', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce(null);

    await expect(service.deleteWorkSchedule(2, 7, 'tenant-A')).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.workSchedule.delete).not.toHaveBeenCalled();
  });
});

describe('workScheduleService.createWorkSchedule — scoping + pattern gate', () => {
  const BASE = {
    employeeId: 9,
    schedule_name: 'General',
    effective_start_date: '2026-09-01',
    total_hours_per_week: 48,
    schedule_pattern: { type: 'weekly', shift: { from: '09:00', to: '18:00' }, offDays: [6, 7] },
  };

  // Note: the tenant param arrives inside `data` — the CONTROLLER is the spoof
  // boundary (it overwrites body tenantId with the verified claim; pinned in
  // workSchedule.controller.tenant-thread.test.js). The service trusts it.
  it('runs the overlap guard inside the tenant and stamps the verified tenant on create', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce(null); // no overlap
    prisma.employee.findFirst.mockResolvedValueOnce({ id: 9 });
    prisma.workSchedule.create.mockResolvedValueOnce({ id: 10 });

    await service.createWorkSchedule({ ...BASE, tenantId: 'tenant-A' });

    expect(prisma.workSchedule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ employeeId: 9, tenantId: 'tenant-A' }),
      }),
    );
    const data = prisma.workSchedule.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe('tenant-A');
  });

  it('rejects an employee that does not exist in the tenant (no orphan rows)', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce(null);
    prisma.employee.findFirst.mockResolvedValueOnce(null);

    await expect(service.createWorkSchedule({ ...BASE, employeeId: 424242 })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(prisma.workSchedule.create).not.toHaveBeenCalled();
  });

  it('rejects a pattern with no shift window (weekend-only rosters are not rosters)', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.createWorkSchedule({ ...BASE, schedule_pattern: { offDays: [6, 7] } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.workSchedule.create).not.toHaveBeenCalled();
  });

  it('accepts a rotating roster with a defined phase', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce(null);
    prisma.employee.findFirst.mockResolvedValueOnce({ id: 9 });
    prisma.workSchedule.create.mockResolvedValueOnce({ id: 11 });

    await service.createWorkSchedule({
      ...BASE,
      schedule_pattern: {
        type: 'rotating',
        rotatingShifts: [{ from: '06:00', to: '12:00' }, { from: '12:00', to: '18:00' }],
        cycle: { days: 3, anchor: '2026-08-01', offIndex: 2 },
      },
    });

    expect(prisma.workSchedule.create).toHaveBeenCalledTimes(1);
  });

  it('cannot attach an overtime rule from another tenant', async () => {
    prisma.workSchedule.findFirst.mockResolvedValueOnce(null);
    prisma.overtimeRule.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.createWorkSchedule({ ...BASE, overtimeRuleId: '55' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.workSchedule.create).not.toHaveBeenCalled();
  });
});

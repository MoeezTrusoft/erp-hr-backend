import { beforeEach, describe, it, expect, jest } from '@jest/globals';
let rows = [],
  failCreate = false;
const db = {
  $executeRaw: jest.fn(),
  employee: { findFirst: jest.fn(async () => ({ id: 1 })) },
  overtimeRule: { findFirst: jest.fn(async () => null) },
  payrollRun: { findFirst: jest.fn(async () => null) },
  workSchedule: {
    findMany: jest.fn(async () => structuredClone(rows)),
    findFirst: jest.fn(async ({ where }) =>
      structuredClone(rows.find((r) => r.id === where.id) || null),
    ),
    update: jest.fn(async ({ where, data }) =>
      Object.assign(
        rows.find((r) => r.id === where.id),
        data,
      ),
    ),
    create: jest.fn(async ({ data }) => {
      if (failCreate) throw Error('insert failed');
      const row = { id: 2, ...data };
      rows.push(row);
      return row;
    }),
    delete: jest.fn(),
  },
};
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: db }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: jest.fn(async (_db, fn) => {
    const before = structuredClone(rows);
    try {
      return await fn(db);
    } catch (e) {
      rows = before;
      throw e;
    }
  }),
}));
const { createWorkSchedule, updateWorkSchedule, deleteWorkSchedule } =
  await import('../../src/services/workScheduleService.js');
const tenantId = 'tenant-a',
  pattern = { shift: { from: '09:00', to: '17:00' }, offDays: [7] };
beforeEach(() => {
  jest.clearAllMocks();
  failCreate = false;
  db.payrollRun.findFirst.mockResolvedValue(null);
  rows = [
    {
      id: 1,
      tenantId,
      employeeId: 1,
      schedule_name: 'Original',
      total_hours_per_week: 48,
      effective_start_date: new Date('2026-01-01'),
      effective_end_date: null,
      schedule_pattern: pattern,
    },
  ];
});
const replacement = (extra = {}) => ({
  tenantId,
  employeeId: 1,
  schedule_name: 'Next',
  total_hours_per_week: 48,
  effective_start_date: '2027-01-01',
  schedule_pattern: pattern,
  ...extra,
});
describe('atomic roster replacement', () => {
  it('does not close the old roster when replacement validation fails', async () => {
    await expect(
      createWorkSchedule(replacement({ schedule_pattern: { offDays: [8] } })),
    ).rejects.toThrow(/invalid schedule/);
    expect(rows[0].effective_end_date).toBeNull();
    expect(db.workSchedule.update).not.toHaveBeenCalled();
  });
  it('rolls back closing the old roster if replacement insertion fails', async () => {
    failCreate = true;
    await expect(createWorkSchedule(replacement())).rejects.toThrow(
      'insert failed',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].effective_end_date).toBeNull();
  });
  it('makes a contiguous dated replacement', async () => {
    await createWorkSchedule(replacement());
    expect(rows[0].effective_end_date.toISOString().slice(0, 10)).toBe(
      '2026-12-31',
    );
    expect(rows[1].effective_start_date.toISOString().slice(0, 10)).toBe(
      '2027-01-01',
    );
  });
  it('rejects equal-start replacement instead of creating a negative interval', async () => {
    await expect(
      createWorkSchedule(replacement({ effective_start_date: '2026-01-01' })),
    ).rejects.toThrow(/overlaps/);
    expect(db.workSchedule.update).not.toHaveBeenCalled();
  });
  it('refuses a historical hard delete', async () => {
    await expect(deleteWorkSchedule(1, null, tenantId)).rejects.toThrow(
      /Historical/,
    );
    expect(db.workSchedule.delete).not.toHaveBeenCalled();
  });
  it('checks overlaps on edit, including future versions', async () => {
    rows[0].effective_end_date = new Date('2026-12-31');
    rows.push({
      ...rows[0],
      id: 2,
      effective_start_date: new Date('2027-01-01'),
      effective_end_date: null,
    });
    await expect(
      updateWorkSchedule(
        1,
        { effective_end_date: '2027-01-02', correctionReason: 'Fix' },
        null,
        tenantId,
      ),
    ).rejects.toThrow(/overlaps/);
  });
  it('prevents corrections affecting locked payroll', async () => {
    db.payrollRun.findFirst.mockResolvedValue({ id: 3 });
    await expect(
      updateWorkSchedule(
        1,
        {
          correctionReason: 'Fix',
          schedule_pattern: { ...pattern, offDays: [6, 7] },
        },
        null,
        tenantId,
      ),
    ).rejects.toThrow(/Recall or cancel/);
  });
});

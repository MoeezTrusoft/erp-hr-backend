import { afterEach, beforeEach, describe, it, expect, jest } from '@jest/globals';
let rows = [],
  failCreate = false;
const db = {
  $executeRaw: jest.fn(),
  employee: { findFirst: jest.fn(async () => ({ id: 1 })) },
  overtimeRule: { findFirst: jest.fn(async () => null) },
  payrollRun: { findFirst: jest.fn(async () => null) },
  shiftTemplate:{findMany:jest.fn(async()=>[])},
  shiftAssignment:{findMany:jest.fn(async()=>[])},
  attendanceSetupDraft:{findUnique:jest.fn(async()=>null)},
  // ROSTER-REEVAL-01 — re-evaluation queue and the impact projection read.
  attendanceEvaluationJob: {
    createMany: jest.fn(async () => ({ count: 0 })),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  attendance: { count: jest.fn(async () => 3) },
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
// ROSTER-REEVAL-01 — mock the queue writer (it transitive imports the whole
// evaluation graph); the args it receives are what the test asserts.
const enqueueEvaluationRange = jest.fn(async () => undefined);
jest.unstable_mockModule(
  '../../src/services/attendanceFinalization.service.js',
  () => ({ enqueueEvaluationRange }),
);
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
    // ROSTER-REEVAL-01 — a rejected write queues nothing.
    expect(enqueueEvaluationRange).not.toHaveBeenCalled();
  });
});

describe('roster-write attendance re-evaluation (ROSTER-REEVAL-01)', () => {
  const today = '2026-10-21';
  const resetWhere = () =>
    db.attendanceEvaluationJob.updateMany.mock.calls[0][0].where;

  // The horizon is capped at the operating "today" (the tenant's civil date),
  // so pin the clock: a real clock would move the horizon off `today` and turn
  // these assertions into calendar-dependent failures.
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(`${today}T06:00:00.000Z`) });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('enqueues evaluation from the effective date through today when saving an in-force correction', async () => {
    const saved = await updateWorkSchedule(
      1,
      {
        correctionReason: 'Shift corrected',
        schedule_pattern: { ...pattern, shift: { from: '15:00', to: '23:00' } },
      },
      null,
      tenantId,
    );
    expect(saved.reevaluation).toEqual({ from: '2026-01-01', to: today, employeeId: 1 });
    // One range job batch for the single employee, from the effective date.
    expect(enqueueEvaluationRange).toHaveBeenCalledWith(
      { tenantId, from: '2026-01-01', to: today, employeeIds: [1] },
      db,
    );
    // DONE/FAILED/PROTECTED rows in the horizon are re-armed.
    expect(resetWhere()).toMatchObject({ tenantId, employeeId: 1 });
    expect(resetWhere().date).toEqual({
      gte: new Date('2026-01-01T00:00:00.000Z'),
      lte: new Date(`${today}T00:00:00.000Z`),
    });
    expect(db.attendanceEvaluationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'PENDING', attempts: 0 }),
      }),
    );
  });

  it('skips the queue for a future-effective version', async () => {
    const saved = await createWorkSchedule(replacement());
    expect(saved.reevaluation).toBeUndefined();
    expect(enqueueEvaluationRange).not.toHaveBeenCalled();
    expect(db.attendanceEvaluationJob.updateMany).not.toHaveBeenCalled();
  });

  it('projects the re-evaluation horizon in the dry-run preview without writing jobs', async () => {
    const preview = await updateWorkSchedule(
      1,
      {
        correctionReason: 'Fix',
        schedule_pattern: { ...pattern, shift: { from: '20:00', to: '04:00' } },
        dryRun: true,
      },
      null,
      tenantId,
    );
    expect(preview.reevaluation).toEqual({
      from: '2026-01-01',
      to: today,
      employeeId: 1,
      affectedDays: 3,
    });
    expect(db.attendanceEvaluationJob.createMany).not.toHaveBeenCalled();
    expect(db.attendanceEvaluationJob.updateMany).not.toHaveBeenCalled();
    expect(enqueueEvaluationRange).not.toHaveBeenCalled();
  });

  it('rolls back with the roster write when the save fails before queueing', async () => {
    failCreate = true;
    await expect(createWorkSchedule(replacement({ effective_start_date: today }))).rejects.toThrow('insert failed');
    expect(enqueueEvaluationRange).not.toHaveBeenCalled();
    expect(db.attendanceEvaluationJob.updateMany).not.toHaveBeenCalled();
  });

  it('caps a very old backdated roster to the 369-day evaluation window', async () => {
    const { reevaluationHorizon } = await import(
      '../../src/services/workScheduleService.js'
    );
    const horizon = reevaluationHorizon({
      action: 'create',
      previous: null,
      row: { effective_start_date: '2020-01-01', effective_end_date: null },
      today: '2026-10-21',
    });
    expect(horizon.from).toBe('2025-10-17');
    expect(horizon.to).toBe('2026-10-21');
    // The bounded range must satisfy the 370-day evaluation range guard.
    const { dateRange } = await import('../../src/lib/attendanceDates.js');
    expect(dateRange(horizon.from, horizon.to, 370)).toHaveLength(370);
  });
});

import { beforeEach, describe, it, expect, jest } from '@jest/globals';

const models = [
  'attendanceSetupDraft',
  'attendanceSetupRelease',
  'attendancePolicyConfig',
  'attendanceDeductionRule',
  'attendanceApprovalLevel',
  'employee',
  'employmentPeriod',
  'workSchedule',
  'holidayCalendar',
  'holiday',
  'employeeHolidayCalendar',
  'employeeDeviceEnrolment',
  'shiftAssignment',
  'leave',
  'leaveRequest',
  'attendanceCallIn',
  'payrollRun',
];
const db = Object.fromEntries(
  models.map((m) => [
    m,
    {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      updateMany: jest.fn(async () => ({ count: 1 })),
      upsert: jest.fn(),
      create: jest.fn(async ({ data }) => ({
        ...data,
        id: 1,
        publishedAt: new Date(),
      })),
    },
  ]),
);
db.$executeRaw = jest.fn();
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: db }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: jest.fn(async (_db, fn) => fn(db)),
}));
const {
  loadAttendanceRuntime,
  previewAttendanceSetup,
  publishAttendanceSetup,
  saveAttendanceSettings,
} = await import('../../src/services/attendanceSetup.service.js');
const tenantId = '4a91f6b2-f98c-480e-81e0-5e928234eb30';
const released = (version, grace = 5) => ({
  version,
  settings: {
    timeZone: 'Asia/Karachi',
    defaultCalendarId: 1,
    profiles: [],
    assignments: [],
    staffingTargets: [],
  },
  policy: { graceMinutes: grace },
  employees: [{ id: 1, payroll_included: true, hire_date: '2026-01-01' }],
  periods: [],
  schedules: [
    {
      employeeId: 1,
      effective_start_date: '2026-01-01',
      schedule_pattern: { shift: { from: '09:00', to: '17:00' }, offDays: [] },
    },
  ],
  calendars: [{ id: 1, year: 2026 }],
  holidays: [],
  calendarAssignments: [],
});
beforeEach(() => {
  jest.clearAllMocks();
  for (const model of models) {
    db[model].findMany.mockResolvedValue([]);
    db[model].findFirst.mockResolvedValue(null);
    db[model].findUnique.mockResolvedValue(null);
  }
});
describe('published runtime isolation', () => {
  it('never reads editable policy rows while resolving attendance', async () => {
    db.attendancePolicyConfig.findUnique.mockResolvedValue({
      graceMinutes: 99,
      status: 'DRAFT',
    });
    db.attendanceSetupRelease.findMany.mockResolvedValue([
      {
        version: 1,
        effectiveFrom: new Date('2026-10-01'),
        coverageThrough: new Date('2026-10-31'),
        config: released(1),
      },
    ]);
    const runtime = await loadAttendanceRuntime({
      tenantId,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(runtime.resolve(1, '2026-10-10').policy.graceMinutes).toBe(5);
    expect(db.attendancePolicyConfig.findUnique).not.toHaveBeenCalled();
  });
  it('selects versions by effective date, including a scheduled future version', async () => {
    db.attendanceSetupRelease.findMany.mockResolvedValue([
      {
        version: 2,
        effectiveFrom: new Date('2026-10-16'),
        coverageThrough: new Date('2026-10-31'),
        config: released(2, 15),
      },
      {
        version: 1,
        effectiveFrom: new Date('2026-10-01'),
        coverageThrough: new Date('2026-10-31'),
        config: released(1),
      },
    ]);
    const runtime = await loadAttendanceRuntime({
      tenantId,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(runtime.resolve(1, '2026-10-15').policy.graceMinutes).toBe(5);
    expect(runtime.resolve(1, '2026-10-16').policy.graceMinutes).toBe(15);
  });
  it('holds unconfigured and expired dates instead of falling back to drafts', async () => {
    const runtime = await loadAttendanceRuntime({
      tenantId,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(runtime.resolve(1, '2026-10-10')).toMatchObject({
      working: null,
      reason: 'SETUP_NOT_PUBLISHED',
    });
  });
  it('scopes all runtime queries to the caller tenant', async () => {
    await loadAttendanceRuntime({
      tenantId,
      from: '2026-10-01',
      to: '2026-10-02',
    });
    for (const model of [
      'attendanceSetupRelease',
      'shiftAssignment',
      'leave',
      'leaveRequest',
      'attendanceCallIn',
    ])
      expect(db[model].findMany.mock.calls[0][0].where.tenantId).toBe(tenantId);
  });
});
describe('setup publication guards', () => {
  it('rejects a stale draft version before any write', async () => {
    db.attendanceSetupDraft.findUnique.mockResolvedValue({ version: 2 });
    await expect(
      saveAttendanceSettings({ tenantId, settings: {}, expectedVersion: 1 }),
    ).rejects.toThrow(/changed/);
    expect(db.attendanceSetupDraft.upsert).not.toHaveBeenCalled();
  });
  it('rejects a preview token after another setting changes', async () => {
    db.attendancePolicyConfig.findUnique.mockResolvedValue({ graceMinutes: 5 });
    const preview = await previewAttendanceSetup({
      tenantId,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    db.attendancePolicyConfig.findUnique.mockResolvedValue({
      graceMinutes: 10,
    });
    await expect(
      publishAttendanceSetup({
        tenantId,
        from: '2026-10-01',
        to: '2026-10-31',
        reason: 'Change',
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow(/changed since preview/);
    expect(db.attendanceSetupRelease.create).not.toHaveBeenCalled();
  });
  it('rejects incomplete setup without creating a release', async () => {
    const preview = await previewAttendanceSetup({
      tenantId,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    await expect(
      publishAttendanceSetup({
        tenantId,
        from: '2026-10-01',
        to: '2026-10-31',
        reason: 'Initial',
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow(/Resolve setup issues/);
    expect(db.attendanceSetupRelease.create).not.toHaveBeenCalled();
  });
  it('rejects changes covering submitted payroll', async () => {
    db.attendancePolicyConfig.findUnique.mockResolvedValue({ graceMinutes: 5 });
    const preview = await previewAttendanceSetup({
      tenantId,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    db.payrollRun.findFirst.mockResolvedValue({ id: 9 });
    await expect(
      publishAttendanceSetup({
        tenantId,
        from: '2026-10-01',
        to: '2026-10-31',
        reason: 'Correction',
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow(/Recall or cancel/);
    expect(db.attendanceSetupRelease.create).not.toHaveBeenCalled();
  });
});

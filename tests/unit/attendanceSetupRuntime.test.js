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
  'shiftTemplate',
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
  buildAttendanceSetup,
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
  it('preserves closed rosters after a department transfer while binding the current shift',async()=>{
    const oldPattern={shift:{templateId:10,from:'09:00',to:'17:00',checkoutCutoffTime:'22:00',checkoutCutoffDayOffset:0}};
    db.employee.findMany.mockResolvedValue([{id:1,businessUnitId:3}]);
    db.shiftTemplate.findMany.mockResolvedValue([
      {id:10,tenantId,departmentId:4,fromTime:'09:00',toTime:'17:00',checkoutCutoffTime:'23:00',checkoutCutoffDayOffset:0},
      {id:20,tenantId,departmentId:3,fromTime:'09:00',toTime:'17:00',checkoutCutoffTime:'21:00',checkoutCutoffDayOffset:0},
    ]);
    db.workSchedule.findMany.mockResolvedValue([
      {employeeId:1,effective_start_date:'2020-01-01',effective_end_date:'2020-12-31',schedule_pattern:oldPattern},
      {employeeId:1,effective_start_date:'2021-01-01',schedule_pattern:{shift:{templateId:20,from:'09:00',to:'17:00'}}},
    ]);
    const config=await buildAttendanceSetup(tenantId,db);
    expect(config.schedules[0].schedule_pattern).toEqual(oldPattern);
    expect(config.schedules[1].schedule_pattern.shift.checkoutCutoffTime).toBe('21:00');
  });
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

describe('live roster overlay (ROSTER-REEVAL-01)', () => {
  // The snapshot still carries the pre-versioning roster (old start, open end);
  // the live table carries the corrected in-place history, the same rows the
  // snapshot was built from, versioned or corrected.
  const liveRosters = () => [
    {
      id: 1,
      employeeId: 1,
      effective_start_date: '2026-01-01',
      effective_end_date: '2026-10-04',
      schedule_pattern: { shift: { from: '09:00', to: '17:00' }, offDays: [] },
    },
    {
      id: 2,
      employeeId: 1,
      effective_start_date: '2026-10-05',
      effective_end_date: null,
      schedule_pattern: { shift: { from: '15:00', to: '23:00' }, offDays: [] },
    },
  ];
  const oneRelease = (grace = 5) => [
    {
      version: 1,
      effectiveFrom: new Date('2026-10-01'),
      coverageThrough: new Date('2026-10-31'),
      config: released(1, grace),
    },
  ];

  it('resolves the updated shift from the live roster without a re-publish', async () => {
    const releases = oneRelease();
    db.attendanceSetupRelease.findMany.mockImplementation(async () => releases);
    db.workSchedule.findMany.mockResolvedValue(liveRosters());
    const runtime = await loadAttendanceRuntime({
      tenantId,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(db.workSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId }) }),
    );
    // Before the version boundary the snapshot-era shift still applies.
    const before = runtime.resolve(1, '2026-10-04');
    expect(before.rosterSource).toBe('live');
    expect(before.shift.start).toEqual(new Date('2026-10-04T09:00:00.000Z'));
    // From the change's effective date the updated shift governs evaluation.
    const after = runtime.resolve(1, '2026-10-06');
    expect(after.working).toBe(true);
    expect(after.rosterSource).toBe('live');
    expect(after.shift.start).toEqual(new Date('2026-10-06T15:00:00.000Z'));
    expect(after.shift.end).toEqual(new Date('2026-10-06T23:00:00.000Z'));
    // The overlay never writes: the published snapshot survives resolution.
    expect(JSON.stringify(releases)).toBe(JSON.stringify(oneRelease()));
  });

  it('keeps snapshot resolution when liveRosters: false is passed', async () => {
    db.attendanceSetupRelease.findMany.mockResolvedValue(oneRelease());
    db.workSchedule.findMany.mockResolvedValue(liveRosters());
    const runtime = await loadAttendanceRuntime({
      tenantId,
      from: '2026-10-01',
      to: '2026-10-31',
      liveRosters: false,
    });
    expect(db.workSchedule.findMany).not.toHaveBeenCalled();
    const info = runtime.resolve(1, '2026-10-06');
    expect(info.rosterSource).toBeUndefined();
    expect(info.shift.start).toEqual(new Date('2026-10-06T09:00:00.000Z'));
  });

  it('honours the ATTENDANCE_LIVE_ROSTERS=false rollback flag', async () => {
    const previous = process.env.ATTENDANCE_LIVE_ROSTERS;
    process.env.ATTENDANCE_LIVE_ROSTERS = 'false';
    try {
      db.attendanceSetupRelease.findMany.mockResolvedValue(oneRelease());
      db.workSchedule.findMany.mockResolvedValue(liveRosters());
      const runtime = await loadAttendanceRuntime({
        tenantId,
        from: '2026-10-01',
        to: '2026-10-31',
      });
      expect(db.workSchedule.findMany).not.toHaveBeenCalled();
      expect(runtime.resolve(1, '2026-10-06').shift.start).toEqual(
        new Date('2026-10-06T09:00:00.000Z'),
      );
    } finally {
      if (previous === undefined) delete process.env.ATTENDANCE_LIVE_ROSTERS;
      else process.env.ATTENDANCE_LIVE_ROSTERS = previous;
    }
  });
});

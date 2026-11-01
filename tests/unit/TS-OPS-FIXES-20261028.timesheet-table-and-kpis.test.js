// Timesheet operator fixes, 2026-10-28.
//   • Employee column search/sort work on the person's NAME (it matched the
//     payroll code only, while the cell shows the name).
//   • "Awaiting attendance" (PENDING_ATTENDANCE) is not an attendance record: it
//     is not listed and it is not part of any KPI / chart denominator.
//   • The tile summary counts distinct, still-detected employee-days.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const day = (d) => new Date(`${d}T00:00:00.000Z`);
const person = (id, code, first, last, position, department) => ({
  id,
  employee_code: code,
  first_name: first,
  last_name: last,
  middle_name: null,
  preferred_name: null,
  employee_name: null,
  photo_url: null,
  job_title: position,
  Position: null,
  businessUnit: { name: department },
  status: 'Active',
});
const people = [
  person(1, 'EMP-001', 'Zara', 'Ahmed', 'Accountant', 'Finance'),
  person(2, 'EMP-002', 'Ali', 'Khan', 'Engineer', 'Technology'),
  person(3, 'EMP-003', 'Bilal', 'Raza', 'Designer', 'Technology'),
];
const row = (id, employeeId, date, status) => ({
  id,
  employeeId,
  date: day(date),
  status,
  check_in: null,
  check_out: null,
  total_hours: null,
  work_mode: null,
  processingState: 'FINALIZED',
  employee: people.find((p) => p.id === employeeId),
});

let attendanceRows = [];
const prismaStub = {
  attendance: { findMany: jest.fn(async () => attendanceRows) },
  attendanceDevicePunch: { findMany: jest.fn(async () => []) },
  attendanceCallIn: { findMany: jest.fn(async () => []) },
  attendanceCorrectionRequest: { findMany: jest.fn(async () => []) },
  attendanceAnomaly: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  attendanceAnomalyApproval: { findMany: jest.fn(async () => []) },
  hrApprovalRequest: { findMany: jest.fn(async () => []) },
  employee: {
    count: jest.fn(async () => people.length),
    findMany: jest.fn(async () => people),
  },
  employmentPeriod: { findMany: jest.fn(async () => []) },
  employeeDeviceEnrolment: { groupBy: jest.fn(async () => []) },
};
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaStub }));
jest.unstable_mockModule('../../src/lib/attendanceRuntime.js', () => ({
  loadAttendanceRuntime: jest.fn(async () => ({ resolve: () => ({}) })),
}));
// The calendar projection is covered by its own tests; here it passes the stored
// rows through so the read model's own filtering is what is under test.
jest.unstable_mockModule('../../src/lib/timesheetRows.js', () => ({
  completeTimesheetRows: ({ records }) => records,
}));

const { listCheckInOuts, getTimesheetKpis, getAttendanceSummaryWeekly, getAbsenteeismTrend } =
  await import('../../src/services/timesheetReport.service.js');

const WINDOW = { from: '2026-10-05', to: '2026-10-09' };
beforeEach(() => {
  attendanceRows = [
    row(1, 1, '2026-10-05', 'PRESENT'),
    row(2, 2, '2026-10-05', 'LATE'),
    row(3, 3, '2026-10-05', 'ABSENT'),
    row(4, 1, '2026-10-06', 'PENDING_ATTENDANCE'),
    row(5, 2, '2026-10-06', 'PRESENT'),
    row(6, 3, '2026-10-06', 'PRESENT'),
  ];
});

describe('Employee column search', () => {
  it('finds a person by name, not only by payroll code', async () => {
    const byName = await listCheckInOuts({ tenantId: TENANT, ...WINDOW, q: 'ali' });
    expect(byName.items.map((r) => r.employee.name)).toEqual(['Ali Khan', 'Ali Khan']);
    const byCode = await listCheckInOuts({ tenantId: TENANT, ...WINDOW, q: 'EMP-003' });
    expect(new Set(byCode.items.map((r) => r.employee.code))).toEqual(new Set(['EMP-003']));
  });
  it('matches every word, case-insensitively, across name, designation and department', async () => {
    const full = await listCheckInOuts({ tenantId: TENANT, ...WINDOW, q: 'ALI kha' });
    expect(new Set(full.items.map((r) => r.employee.id))).toEqual(new Set([2]));
    const dept = await listCheckInOuts({ tenantId: TENANT, ...WINDOW, q: 'technology engineer' });
    expect(new Set(dept.items.map((r) => r.employee.id))).toEqual(new Set([2]));
    expect((await listCheckInOuts({ tenantId: TENANT, ...WINDOW, q: 'nobody here' })).total).toBe(0);
  });
  it('sorts the Employee column by the displayed name', async () => {
    const asc = await listCheckInOuts({
      tenantId: TENANT,
      ...WINDOW,
      sortBy: 'employee',
      sortDir: 'asc',
    });
    const names = asc.items.map((r) => r.employee.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names[0]).toBe('Ali Khan');
  });
});

describe('Awaiting attendance is not a record', () => {
  it('is not listed, and the page total does not count it', async () => {
    const all = await listCheckInOuts({ tenantId: TENANT, ...WINDOW });
    expect(all.items.some((r) => r.status === 'pending-attendance')).toBe(false);
    expect(all.total).toBe(5);
    const asked = await listCheckInOuts({ tenantId: TENANT, ...WINDOW, status: 'pending-attendance' });
    expect(asked.total).toBe(0);
  });
  it('does not count towards the shifts owed', async () => {
    const kpis = await getTimesheetKpis({ tenantId: TENANT, ...WINDOW, _withDeltas: false });
    expect(kpis.availableShifts).toBe(5);
  });
  it('does not dilute the weekly attendance percentage', async () => {
    const { weeks } = await getAttendanceSummaryWeekly({ tenantId: TENANT, month: '2026-10' });
    const week = weeks.find((w) => w.attendancePct != null);
    // 4 attended (PRESENT x3 + LATE) of 5 verdicts; the awaiting row is not a 6th.
    expect(week.attendancePct).toBe(Math.round((4 / 5) * 100));
  });
  it('does not inflate the absenteeism denominator', async () => {
    const { days } = await getAbsenteeismTrend({ tenantId: TENANT, month: '2026-10' });
    const first = days.find((d) => d.date === '2026-10-05');
    const second = days.find((d) => d.date === '2026-10-06');
    expect(first.absenteeismPct).toBe(Math.round((1 / 3) * 100));
    // Day 2: three rows, one awaiting -> two rostered, nobody absent.
    expect(second.absenteeismPct).toBe(0);
  });
});

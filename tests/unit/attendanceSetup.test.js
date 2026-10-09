import { describe, it, expect } from '@jest/globals';
import {
  dateKey,
  dateRange,
  employedOn,
} from '../../src/lib/attendanceDates.js';
import {
  resolveEmployeeDay,
  validateSettings,
  validatePolicy,
  readiness,
  DEFAULT_SETTINGS,
} from '../../src/lib/attendanceSetup.js';
import { evaluateShift } from '../../src/lib/attendanceEvaluator.js';
import { shiftFor } from '../../src/lib/attendanceShift.js';

const employee = {
  id: 1,
  employee_name: 'A',
  managerId: 2,
  payroll_included: true,
  attendanceInputMode: 'DEVICE',
  hire_date: '2026-01-01',
};
const config = () => ({
  settings: { ...DEFAULT_SETTINGS, defaultCalendarId: 1 },
  policy: {
    graceMinutes: 5,
    halfDayAfterMinutes: 30,
    halfDayMinPercent: 50,
    fullDayMinPercent: 90,
  },
  employees: [
    employee,
    { id: 2, hire_date: '2020-01-01', payroll_included: false },
  ],
  periods: [],
  schedules: [
    {
      id: 1,
      employeeId: 1,
      effective_start_date: '2026-01-01',
      effective_end_date: null,
      schedule_pattern: { shift: { from: '09:00', to: '17:00' }, offDays: [7] },
    },
  ],
  calendars: [
    { id: 1, year: 2026 },
    { id: 2, year: 2026 },
  ],
  calendarAssignments: [],
  holidays: [],
  enrolments: [
    {
      employeeId: 1,
      deviceUserId: '11',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
  ],
  approvalLevels: [
    {
      level: 1,
      rowStatus: 'ACTIVE',
      useEmployeeManager: true,
      skipIfUnresolved: false,
    },
  ],
  deductionRules: [],
});
describe('attendance setup civil dates and eligibility', () => {
  it('rejects normalized invalid dates', () =>
    expect(() => dateKey('2026-02-30')).toThrow());
  it('keeps inclusive period boundaries and rejects backwards ranges', () => {
    expect(dateRange('2026-02-27', '2026-03-01')).toHaveLength(3);
    expect(() => dateRange('2026-03-01', '2026-02-27')).toThrow();
  });
  it('resolves employment spells for the actual date, including end day', () => {
    const periods = [
      { employeeId: 1, startDate: '2026-01-01', endDate: '2026-01-31' },
      { employeeId: 1, startDate: '2026-03-01', endDate: null },
    ];
    expect(employedOn(employee, periods, '2026-01-31')).toBe(true);
    expect(employedOn(employee, periods, '2026-02-01')).toBe(false);
    expect(employedOn(employee, periods, '2025-12-31')).toBe(false);
  });
});
describe('effective daily configuration', () => {
  it('does not apply the old calendar after a transfer or the new one before it', () => {
    const c = config();
    c.calendarAssignments = [
      {
        employeeId: 1,
        holidayCalendarId: 1,
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-10-15',
      },
      { employeeId: 1, holidayCalendarId: 2, effectiveFrom: '2026-10-16' },
    ];
    c.holidays = [
      { holidayCalendarId: 1, date: '2026-10-20', fullDay: true },
      { holidayCalendarId: 2, date: '2026-10-10', fullDay: true },
    ];
    expect(resolveEmployeeDay(c, employee, '2026-10-20').working).toBe(true);
    expect(resolveEmployeeDay(c, employee, '2026-10-10').working).toBe(true);
  });
  it('holds a missing roster rather than deriving an absence', () => {
    const c = config();
    c.schedules = [];
    expect(resolveEmployeeDay(c, employee, '2026-10-10')).toMatchObject({
      working: null,
      reason: 'MISSING_ROSTER',
    });
  });
  it('requires an explicit calendar and holds ambiguous rosters', () => {
    const c = config();
    c.settings.defaultCalendarId = null;
    expect(resolveEmployeeDay(c, employee, '2026-10-10').reason).toBe(
      'MISSING_CALENDAR',
    );
    c.schedules.push({ ...c.schedules[0], id: 2 });
    expect(resolveEmployeeDay(c, employee, '2026-10-10').reason).toBe(
      'CONFLICTING_ROSTER',
    );
  });
  it('uses the same daily override as payroll', () => {
    const c = config();
    const result = resolveEmployeeDay(c, employee, '2026-10-10', {
      assignments: [
        {
          employeeId: 1,
          date: '2026-10-10',
          fromTime: '14:00',
          toTime: '22:00',
        },
      ],
    });
    expect(result.shift.start.toISOString()).toBe('2026-10-10T14:00:00.000Z');
  });
  it('shortens the expected day for an edge partial holiday', () => {
    const c = config();
    c.holidays = [
      {
        holidayCalendarId: 1,
        date: '2026-10-10',
        fullDay: false,
        startTime: '09:00',
        endTime: '12:00',
      },
    ];
    const info = resolveEmployeeDay(c, employee, '2026-10-10');
    const result = evaluateShift({
      shift: info.shift,
      policy: info.policy,
      punches: [
        { timestamp: new Date('2026-10-10T12:00Z'), type: 'IN' },
        { timestamp: new Date('2026-10-10T17:00Z'), type: 'OUT' },
      ],
    });
    expect(result.dayCredit).toBe(1);
    expect(result.scheduledMinutes).toBe(300);
    expect(result.latenessMinutes).toBe(0);
  });
  it('does not double-subtract overlapping break and holiday windows', () => {
    const shift = {
      start: new Date('2026-10-10T09:00Z'),
      end: new Date('2026-10-10T17:00Z'),
      exclusions: [
        {
          start: new Date('2026-10-10T12:00Z'),
          end: new Date('2026-10-10T14:00Z'),
        },
        {
          start: new Date('2026-10-10T13:00Z'),
          end: new Date('2026-10-10T14:00Z'),
        },
      ],
    };
    const result = evaluateShift({
      shift,
      punches: [
        { timestamp: shift.start, type: 'IN' },
        { timestamp: shift.end, type: 'OUT' },
      ],
    });
    expect(result.scheduledMinutes).toBe(360);
    expect(result.workedMinutes).toBe(360);
  });
  it('resolves an anchored rotation without guessing from the punch', () => {
    const p = {
      rotatingShifts: [
        { from: '08:00', to: '20:00' },
        { from: '20:00', to: '08:00' },
      ],
      cycle: {
        anchor: '2026-10-01',
        days: 3,
        sequence: [0, 1, null],
        offIndex: [2],
      },
    };
    expect(shiftFor(p, new Date('2026-10-02T00:00Z')).end.toISOString()).toBe(
      '2026-10-03T08:00:00.000Z',
    );
    expect(shiftFor(p, new Date('2026-10-03T00:00Z')).start).toBeNull();
  });
});
describe('readiness and profiles', () => {
  it('reports a complete configuration as ready', () =>
    expect(readiness(config(), '2026-10-01', '2026-10-02').ready).toBe(true));
  it('rejects overlapping employee assignments', () =>
    expect(() =>
      validateSettings({
        ...DEFAULT_SETTINGS,
        profiles: [{ id: 'p', name: 'A' }],
        assignments: [
          { employeeId: 1, profileId: 'p', effectiveFrom: '2026-01-01' },
          { employeeId: 1, profileId: 'p', effectiveFrom: '2026-02-01' },
        ],
      }),
    ).toThrow(/overlapping/));
  it('employee assignment overrides office defaults', () => {
    const c = config();
    c.settings.profiles = [
      {
        id: 'office',
        name: 'Office',
        office: 'HQ',
        policy: { graceMinutes: 10 },
      },
      { id: 'special', name: 'Special', policy: { graceMinutes: 20 } },
    ];
    c.settings.assignments = [
      { employeeId: 1, profileId: 'special', effectiveFrom: '2026-10-01' },
    ];
    expect(
      resolveEmployeeDay(c, { ...employee, payrollOffice: 'HQ' }, '2026-10-10')
        .policy.graceMinutes,
    ).toBe(20);
  });
  it('supports manual monthly without requiring a device or roster', () => {
    const c = config();
    c.employees[0] = { ...employee, attendanceInputMode: 'MANUAL_MONTHLY' };
    c.schedules = [];
    c.enrolments = [];
    expect(readiness(c, '2026-10-01', '2026-10-02').ready).toBe(true);
  });
  it('rejects a missing mandatory manager', () => {
    const c = config();
    c.employees[0] = { ...employee, managerId: null };
    expect(
      readiness(c, '2026-10-01', '2026-10-02').issues.some(
        (i) => i.code === 'APPROVAL_ROUTE',
      ),
    ).toBe(true);
  });
  it('detects conflicting device identities', () => {
    const c = config();
    c.enrolments.push({ ...c.enrolments[0], employeeId: 2 });
    expect(
      readiness(c, '2026-10-01', '2026-10-02').issues.some(
        (i) => i.code === 'DEVICE_IDENTITY_CONFLICT',
      ),
    ).toBe(true);
  });
  it('rejects contradictory policy thresholds', () =>
    expect(
      validatePolicy({ graceMinutes: 60, halfDayAfterMinutes: 30 }),
    ).not.toHaveLength(0));
});

describe('setup calculation edge cases', () => {
  it('excuses a partial holiday covering the complete shift', () => {
    const c = config();
    c.holidays = [
      {
        holidayCalendarId: 1,
        date: '2026-10-10',
        fullDay: false,
        startTime: '08:00',
        endTime: '18:00',
      },
    ];
    expect(resolveEmployeeDay(c, employee, '2026-10-10')).toMatchObject({
      working: false,
      reason: 'HOLIDAY',
    });
  });
  it('places an after-midnight unpaid break in the overnight shift', () => {
    const c = config();
    c.schedules[0].schedule_pattern = {
      shift: { from: '20:00', to: '08:00' },
      offDays: [],
      breaks: [{ from: '02:00', to: '03:00', paid: false }],
    };
    const info = resolveEmployeeDay(c, employee, '2026-10-10');
    const score = evaluateShift({
      shift: info.shift,
      punches: [
        { timestamp: info.shift.start, type: 'IN' },
        { timestamp: info.shift.end, type: 'OUT' },
      ],
    });
    expect(score.scheduledMinutes).toBe(660);
    expect(score.dayCredit).toBe(1);
  });
  it('resolves primary enrolment on each date of a device transfer', () => {
    const c = config();
    c.enrolments = [
      {
        employeeId: 1,
        sn: 'old',
        isPrimary: true,
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-10-15',
      },
      {
        employeeId: 1,
        sn: 'new',
        isPrimary: true,
        effectiveFrom: '2026-10-16',
      },
    ];
    expect(resolveEmployeeDay(c, employee, '2026-10-15').primarySn).toBe('old');
    expect(resolveEmployeeDay(c, employee, '2026-10-16').primarySn).toBe('new');
  });
  it('counts unpaid breaks out of the weekly hours limit', () => {
    const c = config();
    c.schedules[0].schedule_pattern = {
      shift: { from: '09:00', to: '17:00' },
      offDays: [6, 7],
      breaks: [{ from: '12:00', to: '13:00', paid: false }],
      maxHoursPerWeek: 35,
    };
    expect(
      readiness(c, '2026-10-05', '2026-10-09').issues.some(
        (i) => i.code === 'WEEKLY_HOURS',
      ),
    ).toBe(false);
  });
});

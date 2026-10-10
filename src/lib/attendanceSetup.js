import {
  badSetup,
  covers,
  dateKey,
  dateOnly,
  dateRange,
  employedOn,
  overlaps,
  DAY_MS,
  addDays,
} from './attendanceDates.js';
import { validateSchedulePattern } from './schedulePattern.js';
import { shiftFor } from './attendanceShift.js';
import { excludedMinutes } from './attendanceEvaluator.js';

export const DEFAULT_SETTINGS = {
  timeZone: 'Asia/Karachi',
  defaultCalendarId: null,
  profiles: [],
  assignments: [],
  staffingTargets: [],
};
const list = (v) => (Array.isArray(v) ? v : []);
export function validateHolidayWindow(holiday) {
  if (holiday.fullDay !== false) return;
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (
    !clock.test(holiday.startTime) ||
    !clock.test(holiday.endTime) ||
    holiday.startTime >= holiday.endTime
  )
    throw badSetup(
      'Partial holidays require ordered start and end times on the holiday date',
    );
}
export function validatePolicy(policy) {
  const errors = [];
  if (
    policy.overtimeNeedsApproval != null &&
    typeof policy.overtimeNeedsApproval !== 'boolean'
  )
    errors.push('Overtime approval must be true or false');
  for (const k of [
    'graceMinutes',
    'halfDayAfterMinutes',
    'earlyLeaveGraceMin',
    'checkoutLeniencyMin',
    'overtimeAfterMinutes',
    'duplicatePunchWindowMin',
  ]) {
    if (
      policy[k] != null &&
      (!Number.isInteger(policy[k]) || policy[k] < 0 || policy[k] > 1440)
    )
      errors.push(`${k} must be 0–1440 whole minutes`);
  }
  for (const k of [
    'fullDayMinPercent',
    'halfDayMinPercent',
    'halfDayAfterPercentOfShift',
  ]) {
    if (
      policy[k] != null &&
      (!Number.isFinite(policy[k]) || policy[k] < 0 || policy[k] > 100)
    )
      errors.push(`${k} must be 0–100`);
  }
  if (policy.halfDayMinPercent > policy.fullDayMinPercent)
    errors.push('Half-day minimum cannot exceed full-day minimum');
  if (
    policy.halfDayAfterPercentOfShift == null &&
    policy.graceMinutes > policy.halfDayAfterMinutes
  )
    errors.push('Late grace cannot exceed the half-day lateness threshold');
  if (
    policy.shiftGapHours != null &&
    (!Number.isInteger(policy.shiftGapHours) ||
      policy.shiftGapHours < 2 ||
      policy.shiftGapHours > 23)
  )
    errors.push('Shift gap must be 2–23 hours');
  if (
    policy.defaultShiftStart != null &&
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.defaultShiftStart)
  )
    errors.push('Default shift start must be HH:MM');
  return errors;
}
export function validateDeductionGroups(rules) {
  const errors = [],
    groups = new Map();
  for (const rule of list(rules)) {
    if (!rule.enabled || !rule.counterGroup) continue;
    const signature = JSON.stringify(
      [
        'triggerCount',
        'deductionDays',
        'periodScope',
        'maxDeductionDaysPerPeriod',
        'durationThresholdMinutes',
        'overThresholdDeductionDays',
      ].map((k) => rule[k] ?? null),
    );
    if (
      groups.has(rule.counterGroup) &&
      groups.get(rule.counterGroup) !== signature
    )
      errors.push(
        `Counter group ${rule.counterGroup} has inconsistent thresholds or caps`,
      );
    groups.set(rule.counterGroup, signature);
  }
  return errors;
}
export function validateSettings(input) {
  const settings = { ...DEFAULT_SETTINGS, ...input };
  try {
    new Intl.DateTimeFormat('en', { timeZone: settings.timeZone }).format();
  } catch {
    throw badSetup('Choose a valid IANA timezone');
  }
  if (
    settings.defaultCalendarId != null &&
    (!Number.isInteger(settings.defaultCalendarId) ||
      settings.defaultCalendarId < 1)
  )
    throw badSetup('Choose a valid default calendar');
  for (const key of ['profiles', 'assignments', 'staffingTargets'])
    if (!Array.isArray(settings[key]) || settings[key].length > 10000)
      throw badSetup(`Invalid ${key}`);
  const ids = new Set();
  for (const p of settings.profiles) {
    if (!p.id || !p.name?.trim() || ids.has(p.id))
      throw badSetup('Profiles require unique IDs and names');
    ids.add(p.id);
    if (
      p.calendarId != null &&
      (!Number.isInteger(p.calendarId) || p.calendarId < 1)
    )
      throw badSetup('Choose a valid profile calendar');
    if (
      p.attendanceInputMode &&
      !['DEVICE', 'MANUAL_MONTHLY', 'PAID_NO_PUNCH'].includes(
        p.attendanceInputMode,
      )
    )
      throw badSetup('Invalid attendance input mode');
    const errors = validatePolicy(p.policy || {});
    if (errors.length) throw badSetup(`${p.name}: ${errors.join('; ')}`);
  }
  for (const a of settings.assignments) {
    if (
      !ids.has(a.profileId) ||
      !Number.isInteger(a.employeeId) ||
      a.employeeId < 1
    )
      throw badSetup(
        'Each policy assignment requires an employee and an existing profile',
      );
    dateKey(a.effectiveFrom);
    if (a.effectiveTo && dateKey(a.effectiveTo) < dateKey(a.effectiveFrom))
      throw badSetup('Assignment end precedes its start');
  }
  settings.assignments.forEach((a, i) => {
    if (
      settings.assignments
        .slice(i + 1)
        .some((b) => b.employeeId === a.employeeId && overlaps(a, b))
    )
      throw badSetup(
        `Employee ${a.employeeId} has overlapping profile assignments`,
      );
  });
  for (const t of settings.staffingTargets)
    if (!t.office || !Number.isInteger(t.minimum) || t.minimum < 0)
      throw badSetup(
        'Staffing targets require an office and nonnegative minimum',
      );
  return settings;
}

export function effectiveProfile(config, employee, day) {
  const settings = { ...DEFAULT_SETTINGS, ...config.settings };
  const explicit = settings.assignments.filter(
    (a) => a.employeeId === employee.id && covers(a, day),
  );
  const profiles = explicit.length
    ? settings.profiles.filter((p) => p.id === explicit[0].profileId)
    : settings.profiles.filter(
        (p) => p.office && p.office === employee.payrollOffice,
      );
  if (explicit.length > 1 || profiles.length > 1)
    throw badSetup(
      `Conflicting policy profiles for employee ${employee.id}`,
      409,
    );
  const profile = profiles[0];
  return {
    profileId: profile?.id ?? null,
    profileName: profile?.name ?? 'Tenant default',
    policy: { ...config.policy, ...profile?.policy },
    mode:
      profile?.attendanceInputMode || employee.attendanceInputMode || 'DEVICE',
    calendarId: profile?.calendarId ?? settings.defaultCalendarId,
    source: explicit.length
      ? 'Employee assignment'
      : profile
        ? 'Office group'
        : 'Tenant default',
  };
}

export function approvalChain(config, employee, day) {
  return list(config.approvalLevels)
    .filter((l) => l.rowStatus === 'ACTIVE')
    .sort((a, b) => a.level - b.level)
    .map((l) => {
      const id = l.useEmployeeManager ? employee.managerId : l.approverId;
      const approver = list(config.employees).find((e) => e.id === id);
      const resolved =
        approver &&
        approver.id !== employee.id &&
        employedOn(approver, list(config.periods), day);
      const selfVerification =
        approver?.id === employee.id &&
        /^HR$/i.test(l.role) &&
        list(config.approvalLevels).some(
          (next) =>
            next.rowStatus === 'ACTIVE' &&
            next.level > l.level &&
            /^(MANAGEMENT|MGMT)$/i.test(next.role) &&
            next.approverId &&
            next.approverId !== employee.id,
        );
      return {
        ...l,
        approverId: resolved || selfVerification ? id : null,
        resolved: Boolean(resolved || selfVerification),
        skippable: Boolean(l.skipIfUnresolved),
        reason:
          resolved || selfVerification
            ? null
            : 'Missing, inactive or self approver',
      };
    });
}

// One civil-day resolver for preview, attendance, leave and payroll. Device
// timestamps in this installation are wall-clock values encoded as UTC; using
// UTC arithmetic preserves that contract regardless of the server's TZ.
export function resolveEmployeeDay(
  config,
  employee,
  day,
  {
    assignments = [],
    leaves = [],
    callIns = [],
    anchor,
    forLeave = false,
  } = {},
) {
  const key = dateKey(day),
    profile = effectiveProfile(config, employee, key);
  const primary = list(config.enrolments).filter(
    (e) => e.employeeId === employee.id && e.isPrimary && covers(e, key),
  );
  const base = {
    date: dateOnly(day),
    policy: profile.policy,
    profile,
    primarySn: primary.length === 1 ? primary[0].sn : null,
    setupVersion: config.version ?? null,
    working: null,
    reason: null,
  };
  if (
    !employedOn(employee, list(config.periods), key) ||
    employee.payroll_included === false
  )
    return { ...base, working: false, reason: 'NOT_ELIGIBLE' };
  if (profile.mode === 'MANUAL_MONTHLY' && !forLeave)
    return { ...base, working: false, reason: 'MANUAL_MONTHLY' };
  const rosters = list(config.schedules).filter(
    (r) =>
      r.employeeId === employee.id &&
      covers(r, key, 'effective_start_date', 'effective_end_date'),
  );
  const overrides = assignments.filter(
    (a) => a.employeeId === employee.id && dateKey(a.date) === key,
  );
  if (rosters.length !== 1 || overrides.length > 1)
    return {
      ...base,
      reason:
        rosters.length > 1 || overrides.length > 1
          ? 'CONFLICTING_ROSTER'
          : 'MISSING_ROSTER',
    };
  const assignment = overrides[0],
    original = rosters[0].schedule_pattern;
  const pattern =
    assignment?.fromTime && assignment?.toTime
      ? {
          ...original,
          shift: { from: assignment.fromTime, to: assignment.toTime },
          rotatingShifts: undefined,
          shiftByDay: undefined,
        }
      : original;
  if (!validateSchedulePattern(pattern).valid)
    return { ...base, reason: 'INVALID_ROSTER' };
  const shift = shiftFor(pattern, dateOnly(day), anchor);
  const bindings = list(config.calendarAssignments).filter(
    (a) => a.employeeId === employee.id && covers(a, key),
  );
  const ids = bindings.length
    ? bindings.map((a) => a.holidayCalendarId)
    : [profile.calendarId].filter(Boolean);
  if (
    !ids.length ||
    !ids.every((id) =>
      list(config.calendars).some(
        (c) =>
          c.id === id && (c.year == null || c.year === Number(key.slice(0, 4))),
      ),
    )
  )
    return { ...base, pattern, shift, reason: 'MISSING_CALENDAR' };
  const holidays = list(config.holidays).filter(
    (h) => ids.includes(h.holidayCalendarId) && dateKey(h.date) === key,
  );
  const holiday = holidays.find((h) => h.fullDay !== false);
  const onLeave = leaves.some((l) => covers(l, key, 'start_date', 'end_date'));
  const calledIn = callIns.some((c) => dateKey(c.date) === key);
  const cycle = pattern.cycle;
  const index = cycle
    ? ((Math.round((dateOnly(key) - dateOnly(cycle.anchor)) / DAY_MS) %
        cycle.days) +
        cycle.days) %
      cycle.days
    : null;
  const cycleOff =
    cycle &&
    (Array.isArray(cycle.sequence)
      ? cycle.sequence[index] == null
      : [].concat(cycle.offIndex).includes(index));
  const off =
    list(pattern.offDays).includes(dateOnly(key).getUTCDay() || 7) || cycleOff;
  let working = true,
    reason = null;
  if (onLeave) {
    working = false;
    reason = 'APPROVED_LEAVE';
  } else if (calledIn) reason = 'ON_CALL';
  else if (holiday) {
    working = false;
    reason = 'HOLIDAY';
  } else if (assignment?.status === 'off' || off) {
    working = false;
    reason = cycleOff && assignment?.status !== 'off' ? 'ROTATION_OFF' : 'OFF_DAY';
  } else if (profile.mode === 'PAID_NO_PUNCH' || pattern.paidWithoutPunches)
    reason = 'PAID_NO_PUNCH';
  const excused = calledIn
    ? []
    : holidays
        .filter((h) => h.fullDay === false)
        .map((h) =>
          shiftFor(
            { shift: { from: h.startTime, to: h.endTime } },
            dateOnly(key),
          ),
        );
  const breaks = list(pattern.breaks)
    .filter((b) => !b.paid)
    .map((b) => {
      const window = shiftFor({ shift: b }, dateOnly(key));
      // A 02:00 break belongs to tomorrow in a shift starting at 20:00.
      if (shift.end && dateKey(shift.end) > key && window.end <= shift.start)
        return {
          start: new Date(+window.start + DAY_MS),
          end: new Date(+window.end + DAY_MS),
        };
      return window;
    });
  // Trim holiday time at the edges; interior windows are excluded from duration.
  const exclusions = [...excused, ...breaks].filter((x) => x.start && x.end);
  let start = shift.start,
    end = shift.end;
  for (const h of excused) {
    if (h.start <= start && h.end > start)
      start = new Date(Math.min(+end, +h.end));
    if (h.end >= end && h.start < end)
      end = new Date(Math.max(+start, +h.start));
  }
  if (working && start && end && +start >= +end) {
    working = false;
    reason = 'HOLIDAY';
  }
  return {
    ...base,
    pattern,
    shift: { start, end, exclusions },
    working,
    reason,
    holidayName: holiday?.name,
    calendarIds: ids,
    rotating: Boolean(pattern.rotatingShifts?.length && !cycle),
    rosterId: rosters[0].id,
  };
}

export function readiness(config, from, to) {
  const days = dateRange(from, to),
    issues = [],
    employees = [];
  const push = (employeeId, code, message, dates = []) =>
    issues.push({ employeeId, code, message, dates });
  for (const msg of [
    ...validatePolicy(config.policy || {}),
    ...validateDeductionGroups(config.deductionRules),
  ])
    push(null, 'POLICY', msg);
  if (!config.policy)
    push(null, 'POLICY', 'Save an attendance policy before publishing');
  for (const holiday of list(config.holidays))
    try {
      validateHolidayWindow(holiday);
    } catch (error) {
      push(null, 'HOLIDAY', `${holiday.name}: ${error.message}`, [
        dateKey(holiday.date),
      ]);
    }
  for (const employee of list(config.employees)) {
    const active = days.filter(
      (d) =>
        employee.payroll_included !== false &&
        employedOn(employee, list(config.periods), d),
    );
    if (!active.length) continue;
    const before = issues.length,
      errors = new Map(),
      modeSet = new Set();
    let previousEnd = null,
      consecutive = 0;
    // Include the preceding roster when checking the first day of a new release.
    for (const day of dateRange(addDays(from, -31), addDays(from, -1))) {
      try {
        const info = resolveEmployeeDay(config, employee, day);
        if (info.working && info.shift?.end) {
          previousEnd = info.shift.end;
          consecutive++;
        } else consecutive = 0;
      } catch {
        consecutive = 0;
      }
    }
    for (const day of active) {
      let info;
      try {
        info = resolveEmployeeDay(config, employee, day);
      } catch (e) {
        push(employee.id, 'CONFLICT', e.message, [day]);
        continue;
      }
      modeSet.add(info.profile.mode);
      if (info.working && info.shift?.start && info.shift?.end) {
        consecutive++;
        if (
          info.pattern.minRestHours &&
          previousEnd &&
          (info.shift.start - previousEnd) / 3600000 < info.pattern.minRestHours
        )
          errors.set('MINIMUM_REST', [
            ...(errors.get('MINIMUM_REST') || []),
            day,
          ]);
        if (
          info.pattern.maxConsecutiveDays &&
          consecutive > info.pattern.maxConsecutiveDays
        )
          errors.set('CONSECUTIVE_DAYS', [
            ...(errors.get('CONSECUTIVE_DAYS') || []),
            day,
          ]);
        previousEnd = info.shift.end;
        if (info.pattern.maxHoursPerWeek) {
          const hours = dateRange(addDays(day, -6), day).reduce((sum, d) => {
            const r = resolveEmployeeDay(config, employee, d);
            return (
              sum +
              (r.working && r.shift?.start && r.shift?.end
                ? ((r.shift.end - r.shift.start) / 60000 -
                    excludedMinutes(
                      r.shift.start,
                      r.shift.end,
                      r.shift.exclusions,
                    )) /
                  60
                : 0)
            );
          }, 0);
          if (hours > info.pattern.maxHoursPerWeek)
            errors.set('WEEKLY_HOURS', [
              ...(errors.get('WEEKLY_HOURS') || []),
              day,
            ]);
        }
      } else consecutive = 0;
      if (info.working === null)
        errors.set(info.reason, [...(errors.get(info.reason) || []), day]);
      for (const msg of validatePolicy(info.policy))
        errors.set(msg, [...(errors.get(msg) || []), day]);
      const chain = approvalChain(config, employee, day);
      if (
        !chain.length ||
        chain.some((c) => !c.resolved && !c.skippable) ||
        !chain.some((c) => c.resolved)
      )
        errors.set('APPROVAL_ROUTE', [
          ...(errors.get('APPROVAL_ROUTE') || []),
          day,
        ]);
      if (info.profile.mode === 'DEVICE') {
        const enrolments = list(config.enrolments).filter(
          (e) => e.employeeId === employee.id && covers(e, day),
        );
        if (!enrolments.length)
          errors.set('DEVICE_ENROLMENT', [
            ...(errors.get('DEVICE_ENROLMENT') || []),
            day,
          ]);
        if (
          enrolments.some((en) =>
            list(config.enrolments).some(
              (other) =>
                other.employeeId !== employee.id &&
                other.deviceUserId === en.deviceUserId &&
                (!other.sn || !en.sn || other.sn === en.sn) &&
                covers(other, day),
            ),
          )
        )
          errors.set('DEVICE_IDENTITY_CONFLICT', [
            ...(errors.get('DEVICE_IDENTITY_CONFLICT') || []),
            day,
          ]);
        if (enrolments.filter((e) => e.isPrimary).length > 1)
          errors.set('PRIMARY_DEVICE_CONFLICT', [
            ...(errors.get('PRIMARY_DEVICE_CONFLICT') || []),
            day,
          ]);
      }
    }
    for (const [code, dates] of errors)
      push(employee.id, code, code.replaceAll('_', ' ').toLowerCase(), dates);
    if (modeSet.size > 1)
      push(
        employee.id,
        'MODE_CHANGE',
        'Change attendance input mode at an operating-period boundary',
      );
    employees.push({
      id: employee.id,
      name:
        employee.employee_name ||
        [employee.first_name, employee.last_name].filter(Boolean).join(' '),
      code: employee.employee_code,
      status:
        issues.length === before
          ? 'READY'
          : issues.slice(before).some((i) => /CONFLICT/.test(i.code))
            ? 'CONFLICT'
            : 'INCOMPLETE',
      issues: issues.slice(before),
    });
  }
  for (const target of list(config.settings?.staffingTargets))
    for (const day of days) {
      const available = list(config.employees)
        .filter((e) => e.payrollOffice === target.office)
        .filter((e) => {
          try {
            return resolveEmployeeDay(config, e, day).working === true;
          } catch {
            return false;
          }
        }).length;
      if (available < target.minimum)
        push(
          null,
          'STAFFING',
          `${target.office}: ${available} scheduled; minimum ${target.minimum}`,
          [day],
        );
    }
  return {
    from: days[0],
    to: days.at(-1),
    ready: issues.length === 0,
    employeeCount: employees.length,
    readyCount: employees.filter((e) => e.status === 'READY').length,
    employees,
    issues,
  };
}

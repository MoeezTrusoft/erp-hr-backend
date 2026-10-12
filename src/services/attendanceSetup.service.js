import {lockAttendancePeriod} from './attendancePeriod.service.js';
import { createHash } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { tenantTransaction } from '../lib/rlsTenant.js';
import {
  DEFAULT_SETTINGS,
  validateSettings,
  readiness,
  resolveEmployeeDay,
} from '../lib/attendanceSetup.js';
import {
  badSetup,
  dateOnly,
  dateKey,
  dateRange,
} from '../lib/attendanceDates.js';
import { evaluateShift } from '../lib/attendanceEvaluator.js';

const json = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = (tenantId) => {
  if (!tenantId) throw badSetup('Tenant is required', 403);
  return tenantId;
};
export async function buildAttendanceSetup(tenantId, db = prisma) {
  scope(tenantId);
  const [
    draft,
    policy,
    deductionRules,
    approvalLevels,
    employees,
    periods,
    schedules,
    calendars,
    holidays,
    calendarAssignments,
    enrolments,
  ] = await Promise.all([
    db.attendanceSetupDraft.findUnique({ where: { tenantId } }),
    db.attendancePolicyConfig.findUnique({ where: { tenantId } }),
    db.attendanceDeductionRule.findMany({
      where: { tenantId },
      orderBy: { ruleKey: 'asc' },
    }),
    db.attendanceApprovalLevel.findMany({
      where: { tenantId },
      orderBy: { level: 'asc' },
    }),
    db.employee.findMany({
      where: { tenant_id: tenantId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        employee_code: true,
        employee_name: true,
        first_name: true,
        last_name: true,
        managerId: true,
        hire_date: true,
        joining_date: true,
        employement_status: true,
        status: true,
        attendanceInputMode: true,
        payrollOffice: true,
        payroll_included: true,
        work_mode: true,
      },
    }),
    db.employmentPeriod.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    }),
    db.workSchedule.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    db.holidayCalendar.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    }),
    db.holiday.findMany({
      where: { tenantId },
      orderBy: [{ date: 'asc' }, { holidayCalendarId: 'asc' }],
    }),
    db.employeeHolidayCalendar.findMany({
      where: { tenantId },
      orderBy: [
        { employeeId: 'asc' },
        { effectiveFrom: 'asc' },
        { holidayCalendarId: 'asc' },
      ],
    }),
    db.employeeDeviceEnrolment.findMany({
      where: { tenantId },
      orderBy: { id: 'asc' },
    }),
  ]);
  return json({
    draftVersion: draft?.version ?? 0,
    settings: validateSettings(draft?.settings || DEFAULT_SETTINGS),
    policy,
    deductionRules,
    approvalLevels,
    employees,
    periods,
    schedules,
    calendars,
    holidays,
    calendarAssignments,
    enrolments,
  });
}
export async function getAttendanceSetup({ tenantId }) {
  const [config, versions, templates] = await Promise.all([
    buildAttendanceSetup(tenantId),
    prisma.attendanceSetupRelease.findMany({
      where: { tenantId },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        effectiveFrom: true,
        coverageThrough: true,
        reason: true,
        publishedAt: true,
        publishedById: true,
      },
    }),
    prisma.shiftTemplate.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    }),
  ]);
  return { ...config, versions, templates };
}
export async function saveAttendanceSettings({
  tenantId,
  settings,
  expectedVersion,
}) {
  const clean = validateSettings(settings);
  return tenantTransaction(
    prisma,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:attendance-setup`}))`;
      const current = await tx.attendanceSetupDraft.findUnique({
        where: { tenantId },
      });
      if ((current?.version ?? 0) !== expectedVersion)
        throw badSetup('Setup changed; refresh before saving', 409);
      const ids = clean.assignments.map((a) => a.employeeId);
      const known = await tx.employee.findMany({
        where: { tenant_id: scope(tenantId), id: { in: ids } },
        select: { id: true },
      });
      if (ids.some((id) => !known.some((e) => e.id === id)))
        throw badSetup(
          'Profile assignment includes an employee outside this tenant',
        );
      return tx.attendanceSetupDraft.upsert({
        where: { tenantId },
        create: { tenantId, settings: json(clean) },
        update: { settings: json(clean), version: { increment: 1 } },
      });
    },
    { tenantId, txOptions: { isolationLevel: 'Serializable' } },
  );
}
export async function previewAttendanceSetup({ tenantId, from, to }) {
  const config = await buildAttendanceSetup(tenantId);
  const previous = await prisma.attendanceSetupRelease.findFirst({
    where: { tenantId, effectiveFrom: { lte: dateOnly(from) } },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
  });
  const changes = Object.keys(config).filter(
    (k) =>
      k !== 'draftVersion' &&
      JSON.stringify(config[k]) !== JSON.stringify(previous?.config?.[k]),
  );
  const days = dateRange(from, to),
    impact = [];
  const projection = (c, e, d) => {
    if (!c || !e) return null;
    try {
      const info = resolveEmployeeDay(c, e, d);
      return json({
        working: info.working,
        reason: info.reason,
        policy: info.policy,
        shift: info.shift,
        profile: info.profile,
        calendarIds: info.calendarIds,
      });
    } catch (error) {
      return { error: error.message };
    }
  };
  for (const employee of config.employees) {
    const previousEmployee = previous?.config?.employees?.find(
      (e) => e.id === employee.id,
    );
    const dates = days.filter(
      (day) =>
        JSON.stringify(projection(config, employee, day)) !==
        JSON.stringify(projection(previous?.config, previousEmployee, day)),
    );
    if (dates.length)
      impact.push({
        employeeId: employee.id,
        name:
          employee.employee_name ||
          [employee.first_name, employee.last_name].filter(Boolean).join(' '),
        dates,
      });
  }
  return {
    ...readiness(config, from, to),
    previewToken: digest({ config, from: dateKey(from), to: dateKey(to) }),
    changes,
    impact,
    previousVersion: previous?.version ?? null,
  };
}
export async function publishAttendanceSetup({
  tenantId,
  from,
  to,
  reason,
  previewToken,
  publishedById,
}) {
  dateRange(from, to);
  if (!reason?.trim()) throw badSetup('A publication reason is required');
  return tenantTransaction(
    prisma,
    async (tx) => {
      await lockAttendancePeriod(tx,tenantId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope(tenantId)}:attendance-setup`}))`;
      const config = await buildAttendanceSetup(tenantId, tx);
      if (
        previewToken !==
        digest({ config, from: dateKey(from), to: dateKey(to) })
      )
        throw badSetup(
          'Configuration changed since preview; run readiness again',
          409,
        );
      const check = readiness(config, from, to);
      if (!check.ready)
        throw Object.assign(
          badSetup('Resolve setup issues before publishing', 409),
          { issues: check.issues },
        );
      const locked = await tx.payrollRun.findFirst({
        where: {
          tenantId,
          periodStart: { lte: dateOnly(to) },
          periodEnd: { gte: dateOnly(from) },
          status: { notIn: ['CANCELLED', 'FAILED'] },
        },
        select: { id: true },
      });
      if (locked)
        throw badSetup(
          'Recall or cancel payroll covering these dates before changing configuration',
          409,
        );
      const latest = await tx.attendanceSetupRelease.findFirst({
        where: { tenantId },
        orderBy: { version: 'desc' },
      });
      const effective = await tx.attendanceSetupRelease.findFirst({
        where: { tenantId, effectiveFrom: { lte: dateOnly(from) } },
        orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
      });
      const ruleSignature = (rules) =>
        JSON.stringify(
          (rules || []).map(
            ({
              id,
              tenantId,
              status,
              version,
              createdAt,
              updatedAt,
              created_at,
              updated_at,
              ...rule
            }) => rule,
          ),
        );
      if (
        effective &&
        dateKey(from) > dateKey(effective.effectiveFrom) &&
        dateKey(from) <= dateKey(effective.coverageThrough) &&
        ruleSignature(config.deductionRules) !==
          ruleSignature(effective.config.deductionRules)
      ) {
        throw badSetup(
          'Deduction counters must keep one rule set per operating period. Schedule changed deduction rules after the current coverage period, or correct its original effective date after recalling payroll',
          409,
        );
      }
      const version = (latest?.version ?? 0) + 1;
      const release = await tx.attendanceSetupRelease.create({
        data: {
          tenantId,
          version,
          effectiveFrom: dateOnly(from),
          coverageThrough: dateOnly(to),
          reason: reason.trim(),
          publishedById: publishedById ?? null,
          config: { ...config, version },
        },
      });
      await Promise.all(
        [
          'attendancePolicyConfig',
          'attendanceDeductionRule',
          'attendanceApprovalLevel',
        ].map((model) =>
          tx[model].updateMany({
            where: { tenantId, status: 'DRAFT' },
            data: { status: 'PUBLISHED' },
          }),
        ),
      );
      const {enqueueEvaluationRange}=await import('./attendanceFinalization.service.js');
      const operatingTo=[dateKey(to),new Date().toISOString().slice(0,10)].sort()[0];
      if(dateKey(from)<=operatingTo) {
        await enqueueEvaluationRange({tenantId,from:dateKey(from),to:operatingTo,employeeIds:config.employees.map(e=>e.id)},tx);
        await tx.attendanceEvaluationJob.updateMany({where:{tenantId,date:{gte:dateOnly(from),lte:dateOnly(operatingTo)}},
          data:{state:'PENDING',attempts:0,nextAttemptAt:new Date(),lastError:null}});
      }
      return {
        version: release.version,
        effectiveFrom: release.effectiveFrom,
        coverageThrough: release.coverageThrough,
        publishedAt: release.publishedAt,
      };
    },
    { tenantId, txOptions: { isolationLevel: 'Serializable', timeout: 30000 } },
  );
}
export async function restoreAttendanceDraft({
  tenantId,
  version,
  expectedVersion,
}) {
  const release = await prisma.attendanceSetupRelease.findUnique({
    where: { tenantId_version: { tenantId, version } },
  });
  if (!release) throw badSetup('Configuration version not found', 404);
  // Restoration creates an editable draft; it never rewrites a published release.
  return saveAttendanceSettings({
    tenantId,
    settings: release.config.settings,
    expectedVersion,
  });
}

export async function loadAttendanceRuntime({
  tenantId,
  from,
  to,
  db = prisma,
  ignoreLeaves = false,
}) {
  scope(tenantId);
  const first = dateOnly(from),
    last = dateOnly(to);
  const [releases, assignments, leaves, requests, callIns] = await Promise.all([
    db.attendanceSetupRelease.findMany({
      where: { tenantId, effectiveFrom: { lte: last } },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    }),
    db.shiftAssignment.findMany({
      where: { tenantId, date: { gte: first, lte: last } },
      orderBy: { id: 'desc' },
    }),
    db.leave.findMany({
      where: {
        tenantId,
        status: 'APPROVED',
        start_date: { lte: last },
        end_date: { gte: first },
      },
    }),
    db.leaveRequest.findMany({
      where: {
        tenantId,
        status: 'APPROVED',
        startDate: { lte: last },
        endDate: { gte: first },
      },
    }),
    db.attendanceCallIn.findMany({
      where: { tenantId, date: { gte: first, lte: last } },
    }),
  ]);
  const configOn = (day) => {
    // An expired latest release is a setup exception, never a fall-back to an older one.
    const release = releases.find(
      (r) => dateKey(r.effectiveFrom) <= dateKey(day),
    );
    return release && dateKey(release.coverageThrough) >= dateKey(day)
      ? release.config
      : null;
  };
  const indexed = new Map();
  for (const row of assignments) {
    const key = `${row.employeeId}:${dateKey(row.date)}`;
    if (!indexed.has(key)) indexed.set(key, []);
    indexed.get(key).push(row);
  }
  const allLeaves = [
    ...leaves,
    ...requests.map((r) => ({
      ...r,
      start_date: r.startDate,
      end_date: r.endDate,
    })),
  ];
  const leavesByEmployee = new Map(),
    callsByEmployee = new Map();
  for (const row of allLeaves) {
    if (!leavesByEmployee.has(row.employeeId))
      leavesByEmployee.set(row.employeeId, []);
    leavesByEmployee.get(row.employeeId).push(row);
  }
  for (const row of callIns) {
    if (!callsByEmployee.has(row.employeeId))
      callsByEmployee.set(row.employeeId, []);
    callsByEmployee.get(row.employeeId).push(row);
  }
  const employeesByVersion = new Map(),
    configByEmployee = new Map();
  for (const release of releases)
    employeesByVersion.set(
      release.version,
      new Map((release.config.employees || []).map((e) => [e.id, e])),
    );
  return {
    configOn,
    employeeIds: [
      ...new Set(
        releases.flatMap((r) => (r.config.employees || []).map((e) => e.id)),
      ),
    ],
    resolve(employeeId, day, anchor) {
      const config = configOn(day),
        employee = employeesByVersion.get(config?.version)?.get(employeeId);
      if (!config || !employee)
        return {
          date: dateOnly(day),
          working: null,
          reason: config ? 'EMPLOYEE_NOT_PUBLISHED' : 'SETUP_NOT_PUBLISHED',
          setupVersion: config?.version ?? null,
        };
      const cacheKey = `${config.version}:${employeeId}`;
      if (!configByEmployee.has(cacheKey))
        configByEmployee.set(cacheKey, {
          ...config,
          periods: config.periods.filter((r) => r.employeeId === employeeId),
          schedules: config.schedules.filter(
            (r) => r.employeeId === employeeId,
          ),
          calendarAssignments: config.calendarAssignments.filter(
            (r) => r.employeeId === employeeId,
          ),
        });
      return resolveEmployeeDay(configByEmployee.get(cacheKey), employee, day, {
        anchor,
        forLeave: ignoreLeaves,
        assignments: indexed.get(`${employeeId}:${dateKey(day)}`) || [],
        leaves: ignoreLeaves ? [] : leavesByEmployee.get(employeeId) || [],
        callIns: callsByEmployee.get(employeeId) || [],
      });
    },
  };
}
export async function simulateAttendance({
  tenantId,
  employeeId,
  date,
  punches = [],
  useDraft = true,
}) {
  const config = useDraft
    ? await buildAttendanceSetup(tenantId)
    : (
        await loadAttendanceRuntime({ tenantId, from: date, to: date })
      ).configOn(date);
  const employee = config?.employees?.find((e) => e.id === employeeId);
  if (!employee) throw badSetup('Employee is not in this configuration', 404);
  const parsed = punches.map((p) => {
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time) ||
      !['IN', 'OUT'].includes(p.type)
    )
      throw badSetup('Punches require IN/OUT and HH:MM');
    return {
      timestamp: new Date(`${dateKey(date)}T${p.time}:00Z`),
      type: p.type,
    };
  });
  // An OUT earlier than the IN belongs to the following day for an overnight shift.
  if (parsed[0])
    for (const p of parsed)
      if (p.type === 'OUT' && p.timestamp < parsed[0].timestamp)
        p.timestamp = new Date(+p.timestamp + 86400000);
  const info = resolveEmployeeDay(config, employee, date, {
    anchor: parsed[0]?.timestamp,
  });
  if (info.working === null)
    return { context: info, held: true, reason: info.reason };
  if (!info.working)
    return { context: info, held: false, reason: info.reason, verdict: null };
  if (info.reason === 'PAID_NO_PUNCH')
    return {
      context: info,
      held: false,
      verdict: {
        status: 'PRESENT',
        dayCredit: 1,
        workedMinutes: 0,
        scheduledMinutes: (info.shift.end - info.shift.start) / 60000,
      },
      overtime: { minutes: 0, requiresApproval: false },
      deductionRules: [],
      explanation: [
        'This profile credits rostered work without requiring device punches.',
      ],
    };
  const verdict = evaluateShift({
    punches: parsed,
    shift: info.shift,
    policy: info.policy,
    now: new Date(dateOnly(date).getTime() + 3 * 86400000),
  });
  const overtimeMinutes = Math.max(
    0,
    (parsed.findLast((p) => p.type === 'OUT')?.timestamp - info.shift.end) /
      60000 -
      (info.policy.overtimeAfterMinutes ?? 0),
  );
  return {
    context: info,
    verdict,
    overtime: {
      minutes: Number.isFinite(overtimeMinutes) ? overtimeMinutes : 0,
      requiresApproval: info.policy.overtimeNeedsApproval !== false,
    },
    deductionRules: config.deductionRules,
    explanation: [
      'Attendance credit follows the arrival and duration thresholds.',
      'Occurrence deductions accumulate over the configured period; this single-day preview does not assume an occurrence count.',
    ],
  };
}

import prisma from './prisma.js';
import { badSetup, dateOnly, dateKey } from './attendanceDates.js';
import { resolveEmployeeDay } from './attendanceSetup.js';

export async function loadAttendanceRuntime({
  tenantId,
  from,
  to,
  db = prisma,
  ignoreLeaves = false,
}) {
  if (!tenantId) throw badSetup('Tenant is required', 403);
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

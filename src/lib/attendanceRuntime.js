import prisma from './prisma.js';
import { badSetup, dateOnly, dateKey } from './attendanceDates.js';
import { resolveEmployeeDay } from './attendanceSetup.js';

// ROSTER-REEVAL-01 — schedule windows resolve from the live WorkSchedule
// table, not only from the published release snapshot. The snapshot stays the
// source of truth for policy, deductions, grace, approvals and calendars;
// only the roster itself goes live, so an HR shift update takes effect in
// evaluation as soon as it is saved. Set ATTENDANCE_LIVE_ROSTERS=false to
// restore snapshot-only resolution without a redeploy.
const liveRostersEnabled = (override) =>
  override !== undefined
    ? override
    : process.env.ATTENDANCE_LIVE_ROSTERS !== 'false';

export async function loadAttendanceRuntime({
  tenantId,
  from,
  to,
  db = prisma,
  ignoreLeaves = false,
  liveRosters,
}) {
  if (!tenantId) throw badSetup('Tenant is required', 403);
  const first = dateOnly(from),
    last = dateOnly(to);
  const [releases, assignments, leaves, requests, callIns, liveRosterRows] = await Promise.all([
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
    // Rosters in force for ANY day of the window, across the tenant's whole
    // version history: historical rows are never deleted (only future ones),
    // so for every day inside the window the live table holds the same rows
    // the snapshot was built from — possibly corrected in place.
    liveRostersEnabled(liveRosters) && db.workSchedule
      ? db.workSchedule.findMany({
          where: {
            tenantId,
            effective_start_date: { lte: last },
            OR: [
              { effective_end_date: null },
              { effective_end_date: { gte: first } },
            ],
          },
        })
      : Promise.resolve([]),
  ]);
  const liveRostersByEmployee = new Map();
  for (const row of liveRosterRows || []) {
    if (!liveRostersByEmployee.has(row.employeeId))
      liveRostersByEmployee.set(row.employeeId, []);
    liveRostersByEmployee.get(row.employeeId).push(row);
  }
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
      if (!configByEmployee.has(cacheKey)) {
        const own = liveRostersByEmployee.get(employeeId);
        configByEmployee.set(cacheKey, {
          ...config,
          periods: config.periods.filter((r) => r.employeeId === employeeId),
          // ROSTER-REEVAL-01 — the live roster version chain replaces the
          // snapshot's rows for this employee wholesale. Rows are never
          // deleted (only future ones), so for every day the live table
          // carries the snapshot rows, corrected or versioned in place.
          schedules: own?.length
            ? [
                ...config.schedules.filter((r) => r.employeeId !== employeeId),
                ...own,
              ]
            : config.schedules.filter((r) => r.employeeId === employeeId),
          rosterSource: own?.length ? 'live' : undefined,
          calendarAssignments: config.calendarAssignments.filter(
            (r) => r.employeeId === employeeId,
          ),
        });
      }
      const employeeConfig = configByEmployee.get(cacheKey);
      const info = resolveEmployeeDay(employeeConfig, employee, day, {
        anchor,
        forLeave: ignoreLeaves,
        assignments: indexed.get(`${employeeId}:${dateKey(day)}`) || [],
        leaves: ignoreLeaves ? [] : leavesByEmployee.get(employeeId) || [],
        callIns: callsByEmployee.get(employeeId) || [],
      });
      if (employeeConfig.rosterSource === 'live') info.rosterSource = 'live';
      return info;
    },
  };
}

import { dateKey, dateRange, dateOnly } from "./attendanceDates.js";
import { civilNow } from "./attendanceClock.js";
import { attendanceViewMatches } from './attendanceViewFilters.js';

// A read projection: calendar rows never create payroll or attendance marks.
export function completeTimesheetRows({
  records,
  employees,
  anomalies,
  runtime,
  from,
  to,
  now = new Date(),
  filters = {},
}) {
  const rows = new Map(
    records.map((r) => [`${r.employeeId}:${dateKey(r.date)}`, { ...r }]),
  );
  const people = new Map(employees.map((e) => [e.id, e]));
  const days = dateRange(from, to, 370), nowByZone = new Map();
  for (const employee of employees)
    for (const date of days) {
      const key = `${employee.id}:${date}`, previous = rows.get(key);
      const info = previous?.setupSnapshot || runtime.resolve(employee.id, dateOnly(date));
      if (["NOT_ELIGIBLE", "MANUAL_MONTHLY"].includes(info.reason)) continue;
      const status =
        info.calendarStatus ||
        (info.reason === "HOLIDAY"
          ? "HOLIDAY"
          : ["OFF_DAY", "ROTATION_OFF"].includes(info.reason)
            ? "WEEKLY_OFF"
            : info.reason === "APPROVED_LEAVE" ? "LEAVE" : info.working === true ? "WORKDAY" : null);
      const zone=info.timeZone || 'Asia/Karachi';
      if(!nowByZone.has(zone)) nowByZone.set(zone,+civilNow(now,zone));
      const nonworking = ["HOLIDAY", "WEEKLY_OFF", "LEAVE"].includes(status);
      // ATT-DUE-ROWS-01 (2026-10-19) — the table lists what is DUE, not the
      // whole month. A working day is due once its shift has started; a rest
      // day, holiday, leave or setup gap once its civil day has begun in the
      // employee's zone. Days still ahead produced a month of "Awaiting
      // attendance" and "Weekly Off" rows for shifts nobody could have
      // punched yet. Stored records are always shown.
      const dueAt = !nonworking && info.shift?.start ? +info.shift.start : +dateOnly(date);
      if (!previous && dueAt > nowByZone.get(zone)) continue;
      rows.set(key, {
        ...(previous || {
          id: null,
          employeeId: employee.id,
          employee,
          date: dateOnly(date),
          total_hours: nonworking ? 0 : null,
          processingState: nonworking ? "CALENDAR" : info.working == null ? "SETUP_REQUIRED" : "AWAITING_EVALUATION",
          check_in: null,
          check_out: null,
        }),
        status: previous && (!nonworking || previous.check_in || previous.check_out) ? previous.status : nonworking ? status : info.working == null ? "SETUP_REQUIRED" : "PENDING_ATTENDANCE",
        calendarStatus: status,
        holidayName: info.holidayName,
        plannedShift: info.shift || null,
        timeZone: info.timeZone || null,
        assignedSites: (info.sites || []).filter(site => info.siteAssignment?.siteIds?.includes(site.id)).map(site => ({ id: site.id, name: site.name })),
        setupReason: info.reason,
      });
    }
  for (const anomaly of anomalies) {
    if (
      anomaly.type !== "ABSENT" ||
      anomaly.status === "RESOLVED" ||
      anomaly.evidenceState === "SUPERSEDED" ||
      !anomaly.date ||
      !people.has(anomaly.employeeId)
    )
      continue;
    const key = `${anomaly.employeeId}:${dateKey(anomaly.date)}`,
      previous = rows.get(key);
    if (["HOLIDAY", "WEEKLY_OFF", "LEAVE"].includes(previous?.calendarStatus) || previous?.processingState === "SETUP_REQUIRED") continue;
    if (!previous) {
      // No due row for this day (ATT-DUE-ROWS-01): an absence can only be
      // attached once the day has begun in the employee's zone.
      const zone = runtime.resolve(anomaly.employeeId, dateOnly(dateKey(anomaly.date)))?.timeZone || 'Asia/Karachi';
      if(!nowByZone.has(zone)) nowByZone.set(zone,+civilNow(now,zone));
      if (+dateOnly(dateKey(anomaly.date)) > nowByZone.get(zone)) continue;
    }
    if (previous) {
      previous.absenceAnomaly = true;
      if (
        !previous.check_in &&
        !previous.check_out &&
        !previous.manually_corrected
      )
        previous.status = "ABSENT";
    } else
      rows.set(key, {
        id: null,
        employeeId: anomaly.employeeId,
        employee: people.get(anomaly.employeeId),
        date: dateOnly(anomaly.date),
        status: "ABSENT",
        absenceAnomaly: true,
        processingState: "NEEDS_REVIEW",
        total_hours: 0,
        check_in: null,
        check_out: null,
      });
  }
  return [...rows.values()].filter(row => attendanceViewMatches(row.setupSnapshot || runtime.resolve(row.employeeId,dateOnly(row.date)),filters));
}

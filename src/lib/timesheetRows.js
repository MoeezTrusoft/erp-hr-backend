import { dateKey, dateRange, dateOnly } from "./attendanceDates.js";

// A read projection: calendar rows never create payroll or attendance marks.
export function completeTimesheetRows({
  records,
  employees,
  anomalies,
  runtime,
  from,
  to,
}) {
  const rows = new Map(
    records.map((r) => [`${r.employeeId}:${dateKey(r.date)}`, { ...r }]),
  );
  const people = new Map(employees.map((e) => [e.id, e]));
  for (const employee of employees)
    for (const date of dateRange(from, to, 370)) {
      const info = runtime.resolve(employee.id, dateOnly(date));
      const status =
        info.calendarStatus ||
        (info.reason === "HOLIDAY"
          ? "HOLIDAY"
          : ["OFF_DAY", "ROTATION_OFF"].includes(info.reason)
            ? "WEEKLY_OFF"
            : null);
      if (!status) continue;
      const key = `${employee.id}:${date}`,
        previous = rows.get(key);
      rows.set(key, {
        ...(previous || {
          id: null,
          employeeId: employee.id,
          employee,
          date: dateOnly(date),
          total_hours: 0,
          processingState: "CALENDAR",
          check_in: null,
          check_out: null,
        }),
        status,
        calendarStatus: status,
        holidayName: info.holidayName,
      });
    }
  for (const anomaly of anomalies) {
    if (
      anomaly.type !== "ABSENT" ||
      anomaly.evidenceState === "SUPERSEDED" ||
      !anomaly.date ||
      !people.has(anomaly.employeeId)
    )
      continue;
    const key = `${anomaly.employeeId}:${dateKey(anomaly.date)}`,
      previous = rows.get(key);
    if (previous?.calendarStatus) continue;
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
  return [...rows.values()];
}

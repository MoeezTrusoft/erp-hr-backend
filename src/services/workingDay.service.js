import { dateKey, dateRange } from '../lib/attendanceDates.js';
import { loadAttendanceRuntime } from './attendanceSetup.service.js';

export async function resolveWorkingDays({
  employeeId,
  from,
  to,
  tenantId,
  runtime,
  db,
  ignoreLeaves = false,
}) {
  const context =
    runtime ||
    (await loadAttendanceRuntime({ tenantId, from, to, ignoreLeaves, db }));
  return new Map(
    dateRange(from, to, 370).map((day) => [
      day,
      context.resolve(employeeId, day),
    ]),
  );
}
export async function isWorkingDay({ employeeId, date, tenantId }) {
  return (
    await resolveWorkingDays({ employeeId, from: date, to: date, tenantId })
  ).get(dateKey(date));
}

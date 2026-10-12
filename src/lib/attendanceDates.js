// Attendance configuration dates are civil dates, not server-local instants.
export const DAY_MS = 86400000;
export const badSetup = (message, status = 400) =>
  Object.assign(new Error(message), { status, statusCode: status });
export function dateKey(value) {
  if (
    value &&
    typeof value.getTime === 'function' &&
    typeof value.toISOString === 'function'
  ) {
    if (!Number.isFinite(value.getTime())) throw badSetup('Invalid date');
    return value.toISOString().slice(0, 10);
  }
  const key = String(value ?? '').slice(0, 10);
  const d = new Date(`${key}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(key) ||
    !Number.isFinite(d.getTime()) ||
    d.toISOString().slice(0, 10) !== key
  ) {
    throw badSetup('Use a valid YYYY-MM-DD date');
  }
  return key;
}
export const dateOnly = (value) => new Date(`${dateKey(value)}T00:00:00.000Z`);
export const addDays = (value, days) =>
  new Date(dateOnly(value).getTime() + days * DAY_MS);
export function dateRange(from, to, maxDays = 366) {
  const first = dateOnly(from),
    last = dateOnly(to);
  if (last < first || (last - first) / DAY_MS >= maxDays)
    throw badSetup(`Choose an ordered date range of at most ${maxDays} days`);
  return Array.from({ length: (last - first) / DAY_MS + 1 }, (_, i) =>
    dateKey(addDays(first, i)),
  );
}
export const covers = (
  row,
  date,
  start = 'effectiveFrom',
  end = 'effectiveTo',
) =>
  dateKey(row[start]) <= dateKey(date) &&
  (row[end] == null || dateKey(row[end]) >= dateKey(date));
export function employedOn(employee, periods, date) {
  const spells = periods.filter((p) => p.employeeId === employee.id);
  if (spells.length)
    return spells.some((p) => covers(p, date, 'startDate', 'endDate'));
  const start = employee.hire_date || employee.joining_date;
  return (
    !/inactive|terminated/i.test(
      employee.employement_status || employee.status || '',
    ) &&
    (!start || dateKey(start) <= dateKey(date))
  );
}
export const overlaps = (a, b, start = 'effectiveFrom', end = 'effectiveTo') =>
  dateKey(a[start]) <= (b[end] ? dateKey(b[end]) : '9999-12-31') &&
  dateKey(b[start]) <= (a[end] ? dateKey(a[end]) : '9999-12-31');

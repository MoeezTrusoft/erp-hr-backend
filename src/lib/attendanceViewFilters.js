// Filters use the published employee-day assignment, not today's roster.
export function attendanceViewMatches(info, { site, department, shift } = {}) {
  return (!site || info.siteAssignment?.siteIds?.includes(site) === true) &&
    (!department || String(info.departmentId) === String(department)) &&
    (!shift || shift === shiftKey(info.shift));
}
export const shiftKey = shift => shift?.start && shift?.end
  ? `${new Date(shift.start).toISOString().slice(11,16)}–${new Date(shift.end).toISOString().slice(11,16)}` : '';

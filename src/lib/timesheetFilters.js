// Column filters of the Timesheet attendance table that work on the finished rows: shift window, check-in and
// check-out time windows, worked hours and the request state. Times are the UTC wall-clock the feed is pinned to
// (the same clock the cells print), as HH:MM.

const MIN = 60000;
const toMinutes = (hhmm) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const clock = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(+d) ? null : d.getUTCHours() * 60 + d.getUTCMinutes();
};

// Is minute-of-day `at` inside [from, to]? A window that ends before it starts runs across midnight.
export const inWindow = (at, from, to) => {
  if (at == null) return false;
  if (from == null && to == null) return true;
  if (from != null && to != null && to < from) return at >= from || at <= to;
  return (from == null || at >= from) && (to == null || at <= to);
};

export const REQUEST_STATES = ["none", "unsubmitted", "pending", "approved", "rejected"];
const requestState = (request) => (request ? String(request.status || "").toLowerCase() : "none");

/**
 * @param rows rows as listCheckInOuts builds them ({ plannedShift:{start,end}, checkIn, checkOut, totalHours, request })
 * @param f { shiftFrom, shiftTo, checkInFrom, checkInTo, checkOutFrom, checkOutTo, workedMin, workedMax, requestStatus }
 */
export function applyTimesheetColumnFilters(rows, f = {}) {
  const shiftFrom = toMinutes(f.shiftFrom), shiftTo = toMinutes(f.shiftTo);
  const inFrom = toMinutes(f.checkInFrom), inTo = toMinutes(f.checkInTo);
  const outFrom = toMinutes(f.checkOutFrom), outTo = toMinutes(f.checkOutTo);
  const workedMin = f.workedMin === "" || f.workedMin == null ? null : Number(f.workedMin);
  const workedMax = f.workedMax === "" || f.workedMax == null ? null : Number(f.workedMax);
  const request = REQUEST_STATES.includes(String(f.requestStatus || "").toLowerCase()) ? String(f.requestStatus).toLowerCase() : null;
  const active = [shiftFrom, shiftTo, inFrom, inTo, outFrom, outTo, workedMin, workedMax, request].some((v) => v != null);
  if (!active) return rows;

  return rows.filter((r) => {
    if (shiftFrom != null || shiftTo != null) {
      // The whole shift sits inside the window: it starts at or after From and ends at or before To.
      const start = clock(r.plannedShift?.start);
      const end = clock(r.plannedShift?.end);
      if (start == null || end == null) return false;
      const from = shiftFrom ?? 0;
      let to = shiftTo ?? Infinity; // no upper end: any shift that starts late enough
      if (Number.isFinite(to) && to <= from) to += 24 * 60; // a window across midnight
      // Only a window that itself crosses midnight can take a start earlier in the clock than From.
      const wraps = Number.isFinite(to) && to > 24 * 60;
      const startAt = start >= from ? start : wraps ? start + 24 * 60 : -1;
      const span = (end - start + 24 * 60) % (24 * 60) || 24 * 60;
      if (!(startAt >= from && startAt + span <= to)) return false;
    }
    if ((inFrom != null || inTo != null) && !inWindow(clock(r.checkIn), inFrom, inTo)) return false;
    if ((outFrom != null || outTo != null) && !inWindow(clock(r.checkOut), outFrom, outTo)) return false;
    if (workedMin != null || workedMax != null) {
      const hours = r.totalHours == null ? null : Number(r.totalHours);
      if (hours == null || !Number.isFinite(hours)) return false;
      if (workedMin != null && hours < workedMin) return false;
      if (workedMax != null && hours > workedMax) return false;
    }
    if (request && requestState(r.request) !== request) return false;
    return true;
  });
}

export const shiftSortKey = (row) => {
  const at = clock(row.plannedShift?.start);
  return at == null ? null : at;
};
export const MINUTE_MS = MIN;

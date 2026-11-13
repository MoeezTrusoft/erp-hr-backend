// Which attendance rows the Timesheet list shows (operator, 2026-11-01): no days still to come, no weekly offs,
// nothing before an employee joined, and no "setup required" row for a day on which the employee was not yet
// enrolled on a device. These are display rules: the stored attendance and payroll are untouched.

const DAY = 86400000;
const PAKISTAN_OFFSET_MS = 5 * 3600000;

// The calendar day (UTC midnight) it is now in Pakistan time.
export const todayInPakistan = (now = new Date()) => {
  const local = new Date(+now + PAKISTAN_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
};

const dayStart = (value) => {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/**
 * @param rows        rows with { employeeId, date, status }
 * @param ctx.today   UTC midnight of today (Pakistan time)
 * @param ctx.joining Map employeeId -> joining date (or null)
 * @param ctx.enrolledFrom Map employeeId -> earliest device enrolment start (missing = never enrolled)
 * @param ctx.showWeeklyOff keep WEEKLY_OFF rows (only when the user asked for that status)
 */
export function visibleTimesheetRows(rows, { today, joining = new Map(), enrolledFrom = new Map(), showWeeklyOff = false }) {
  return rows.filter((row) => {
    const day = +dayStart(row.date);
    if (day > +today) return false;
    if (!showWeeklyOff && row.status === "WEEKLY_OFF") return false;
    const joined = joining.get(row.employeeId);
    if (joined && day < +dayStart(joined)) return false;
    if (row.status === "SETUP_REQUIRED") {
      const from = enrolledFrom.get(row.employeeId);
      if (!from || day < +dayStart(from)) return false;
    }
    return true;
  });
}

export const DAY_MS = DAY;

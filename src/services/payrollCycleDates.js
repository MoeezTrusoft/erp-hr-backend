// src/services/payrollCycleDates.js — the dates of ONE payroll month, derived from the tenant's calendar rule.
//
// PayrollCalendar holds one stored instant per field (attendanceCutoff, approvalsClose). The Cycle & Calendar screen reads them as a
// RULE ("Timesheet cut-off: 3rd @ 04:59"), but the timesheet gates compared the raw instant with now, so a calendar saved once for
// September stayed "passed" for every later month and the "attendance cycle locked" gate never closed. The rule is: the same
// day-of-month and wall-clock time, in the month AFTER the payroll month (October attendance closes on 3 Nov 04:59).
//
// Wall clock is Asia/Karachi (fixed UTC+5, no DST), the company time zone every cut-off is entered in.
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

const daysInMonth = (year, month1) => new Date(Date.UTC(year, month1, 0)).getUTCDate();

/**
 * @param {Date|string|null} stored the calendar's stored instant (attendanceCutoff or approvalsClose)
 * @param {string} month the payroll month, YYYY-MM
 * @returns {Date|null} the instant that applies to that month, or null when nothing is configured
 */
export function cycleInstantForMonth(stored, month) {
  if (stored == null) return null;
  const at = new Date(stored);
  if (Number.isNaN(at.getTime())) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(String(month ?? ""));
  if (!match) return null;
  const wall = new Date(at.getTime() + PKT_OFFSET_MS);
  const year = Number(match[1]);
  const monthAfter = Number(match[2]) + 1;
  const targetYear = year + Math.floor((monthAfter - 1) / 12);
  const targetMonth = ((monthAfter - 1) % 12) + 1;
  const day = Math.min(wall.getUTCDate(), daysInMonth(targetYear, targetMonth));
  const local = Date.UTC(
    targetYear,
    targetMonth - 1,
    day,
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    wall.getUTCSeconds(),
    wall.getUTCMilliseconds(),
  );
  return new Date(local - PKT_OFFSET_MS);
}

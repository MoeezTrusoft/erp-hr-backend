// F-05 (audit 2026-11-08) — long unreported absences. The payroll engine prices
// each absent day but nothing raises the case: Azeem sat ABSENT 16 days while
// still Active (register row 432), Rustam 15 days after leave (row 433).
//
// Streak = consecutive ABSENT days counted back from the employee's latest
// attendance row. Weekly offs and holidays inside the streak neither count nor
// break it; any other status (present, late, leave, half day, missing punch,
// pending...) ends it, because the employee was demonstrably around or covered.

const NEUTRAL = new Set(["WEEKLY_OFF", "HOLIDAY"]);
const day = (d) => new Date(d).toISOString().slice(0, 10);

/** rows: one employee's attendance [{ date, status }], any order. */
export function absenceStreak(rows) {
  const sorted = [...rows].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  let days = 0,
    from = null,
    to = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const { status, date } = sorted[i];
    if (NEUTRAL.has(status)) continue;
    if (status !== "ABSENT") break;
    days += 1;
    from = day(date);
    to ??= day(date);
  }
  return { days, from, to };
}

/** byEmployee: Map<employeeId, rows[]>. Returns those at or above minDays, longest first. */
export function longAbsences(byEmployee, minDays) {
  const out = [];
  for (const [employeeId, rows] of byEmployee) {
    const s = absenceStreak(rows);
    if (s.days >= minDays) out.push({ employeeId, ...s });
  }
  return out.sort((a, b) => b.days - a.days || a.employeeId - b.employeeId);
}

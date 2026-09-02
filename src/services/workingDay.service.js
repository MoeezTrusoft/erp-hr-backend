// src/services/workingDay.service.js
//
// "Is this a working day for this employee?" — the question the attendance
// cutoff rule turns on. A missing check-out is searched for until the NEXT
// SHIFT'S check-in when the next day is a working day, but only until shift end
// plus a leniency window when it is not.
//
// Deliberately derived, not materialised. The alternative was generating twelve
// months of shift_assignments rows up front (~27k for this roster) purely so
// this question could be answered by a lookup. The recurring rule already
// carries the answer, and speculative rows would need regenerating every time
// somebody's roster or leave changed.
//
// Precedence, strongest first: approved leave > holiday > rostered off-day.
// An employee on approved leave during a holiday is not "at work" twice over;
// the reason simply reports the strongest one.
//
// HR-ATT-POLICY-01.
import prisma from "../lib/prisma.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(value) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** ISO weekday: Monday = 1 … Sunday = 7, matching schedule_pattern.offDays. */
function isoDow(date) {
  const js = date.getDay();
  return js === 0 ? 7 : js;
}

/**
 * Working-day verdicts for a date range, for one employee.
 *
 * Returns a Map keyed by YYYY-MM-DD so a caller can ask about any day in the
 * range without a query per day — the evaluator asks about "tomorrow" for every
 * shift it scores, which would otherwise be one round trip each.
 */
export async function resolveWorkingDays({ employeeId, from, to }) {
  const first = startOfDay(from);
  const last = startOfDay(to);

  const [schedule, holidays, leaves] = await Promise.all([
    // Effective-dated: off-days can change mid-month for one employee, and the
    // old pattern must keep applying to the days it covered.
    prisma.workSchedule.findFirst({
      where: {
        employeeId,
        effective_start_date: { lte: last },
        OR: [{ effective_end_date: null }, { effective_end_date: { gte: first } }],
      },
      orderBy: { effective_start_date: "desc" },
      select: { schedule_pattern: true },
    }),
    // Holidays the employee is actually entitled to. If they are assigned to
    // one or more calendars (employee_holiday_calendars, effective-dated), only
    // those apply — two groups in one tenant can legitimately observe different
    // days. With no assignment we fall back to every holiday in the tenant,
    // which is the current single-calendar reality and keeps behaviour stable.
    prisma.employeeHolidayCalendar
      .findMany({
        where: {
          employeeId,
          effectiveFrom: { lte: last },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: first } }],
        },
        select: { holidayCalendarId: true },
      })
      .then((assigned) =>
        prisma.holiday.findMany({
          where: {
            date: { gte: first, lte: last },
            ...(assigned.length
              ? { holidayCalendarId: { in: assigned.map((a) => a.holidayCalendarId) } }
              : {}),
          },
          select: { date: true, name: true, fullDay: true },
        }),
      ),
    prisma.leave.findMany({
      where: {
        employeeId,
        status: "APPROVED",
        start_date: { lte: last },
        end_date: { gte: first },
      },
      select: { start_date: true, end_date: true, type: true },
    }),
  ]);

  const offDays = new Set(
    Array.isArray(schedule?.schedule_pattern?.offDays)
      ? schedule.schedule_pattern.offDays.map(Number)
      : [],
  );

  const holidayByDay = new Map();
  for (const h of holidays) {
    // A half-day holiday is still a working day; only a full day removes it.
    if (h.fullDay === false) continue;
    holidayByDay.set(startOfDay(h.date).toISOString().slice(0, 10), h.name);
  }

  const out = new Map();
  for (let t = first.getTime(); t <= last.getTime(); t += DAY_MS) {
    const day = new Date(t);
    const key = day.toISOString().slice(0, 10);

    const onLeave = leaves.find(
      (l) => startOfDay(l.start_date) <= day && startOfDay(l.end_date) >= day,
    );
    if (onLeave) {
      out.set(key, { date: day, working: false, reason: "APPROVED_LEAVE", detail: onLeave.type });
      continue;
    }

    if (holidayByDay.has(key)) {
      out.set(key, { date: day, working: false, reason: "HOLIDAY", detail: holidayByDay.get(key) });
      continue;
    }

    if (offDays.has(isoDow(day))) {
      out.set(key, { date: day, working: false, reason: "OFF_DAY", detail: null });
      continue;
    }

    out.set(key, { date: day, working: true, reason: null, detail: null });
  }

  return out;
}

/**
 * Single-day convenience.
 *
 * An employee with NO schedule has no off-days, so every day reads as working.
 * That is the safe direction here: it keeps the cutoff window short (search only
 * until the next shift) rather than granting a long leniency window to the 16
 * roster-only employees whose shifts nobody has defined.
 */
export async function isWorkingDay({ employeeId, date }) {
  const day = startOfDay(date);
  const map = await resolveWorkingDays({ employeeId, from: day, to: day });
  return map.get(day.toISOString().slice(0, 10));
}

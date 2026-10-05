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
export async function resolveWorkingDays({ employeeId, from, to, tenantId }) {
  const first = startOfDay(from);
  const last = startOfDay(to);

  const [schedules, holidays, leaves, callIns] = await Promise.all([
    // HR-ROSTER-01 — EVERY schedule covering the window, resolved per day.
    //
    // This used to be a findFirst: one schedule, the newest overlapping the
    // range, applied to all of it. The comment claimed effective dating and the
    // query did not implement it, which is harmless only while each employee
    // has exactly one row. With two, the newer pattern reaches backwards over
    // days the older one covered — correcting a weekend today would turn last
    // month's rest days into working days, and reconciled attendance into
    // absences. A month that has been closed must stay closed.
    prisma.workSchedule.findMany({
      where: {
        employeeId,
        ...(tenantId !== undefined ? { tenantId } : {}),
        effective_start_date: { lte: last },
        OR: [{ effective_end_date: null }, { effective_end_date: { gte: first } }],
      },
      orderBy: { effective_start_date: "desc" },
      select: {
        schedule_pattern: true,
        effective_start_date: true,
        effective_end_date: true,
      },
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
          ...(tenantId !== undefined ? { tenantId } : {}),
          effectiveFrom: { lte: last },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: first } }],
        },
        select: { holidayCalendarId: true },
      })
      .then((assigned) =>
        prisma.holiday.findMany({
          where: {
            date: { gte: first, lte: last },
            ...(tenantId !== undefined ? { tenantId } : {}),
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
        ...(tenantId !== undefined ? { tenantId } : {}),
        status: "APPROVED",
        start_date: { lte: last },
        end_date: { gte: first },
      },
      select: { start_date: true, end_date: true, type: true },
    }),
    // HR-ATT-ONCALL-01 — a weekend on-call is an explicit HR instruction for
    // ONE date. Cheapest to read alongside the rest: one row per called-in day.
    prisma.attendanceCallIn.findMany({
      where: {
        employeeId,
        ...(tenantId !== undefined ? { tenantId } : {}),
        date: { gte: first, lte: last },
      },
      select: { date: true, reason: true },
    }),
  ]);

  /**
   * Everything derived from one schedule_pattern. Computed once per schedule
   * rather than once per day — a month with two schedules derives twice, not
   * sixty times.
   */
  const derive = (pattern) => {
    const offDays = new Set(
      Array.isArray(pattern?.offDays) ? pattern.offDays.map(Number) : [],
    );

    // HR-ATT-ROTATING-02 — a rotating roster rests on the ROTATION, not on a
    // weekday, so `offDays` is legitimately empty and every day below reads as
    // working. That is right for the shift lookup and wrong for absence
    // marking, which would invent an unpaid day out of every rest day. Flag it
    // here rather than re-deriving the pattern in each caller.
    const isRotating = Boolean(
      Array.isArray(pattern?.rotatingShifts) && pattern.rotatingShifts.length,
    );

    // HR-ATT-ROTATING-03 — when the rotation's PHASE is known the rest day is
    // an ordinary off-day and nothing needs suppressing. `offDays` cannot hold
    // it: that is a weekday list and a 3-day cycle walks through the week, so
    // the phase is stored as {days, offIndex, anchor} and evaluated per day.
    const cycle = pattern?.cycle;
    const cycleDays = Number(cycle?.days) > 0 ? Number(cycle.days) : null;
    const cycleAnchor = cycleDays ? startOfDay(new Date(cycle.anchor)) : null;
    // One rest position ("work, work, off") or several (4-day "day, night,
    // off, off") — a number is shorthand for the single-element list. A Set so
    // both spellings answer the same question: is this cycle index a rest?
    const offList = Array.isArray(cycle?.offIndex) ? cycle.offIndex : [cycle?.offIndex];
    const cycleOffs = new Set(
      offList.map(Number).filter((n) => Number.isInteger(n) && n >= 0),
    );
    const hasPhase = Boolean(cycleDays && cycleAnchor && cycleOffs.size);

    return {
      offDays,
      hasPhase,
      cycleOffs,
      // Only an UNKNOWN phase needs the ROTATING-02 fallback.
      rotating: isRotating && !hasPhase,
      /** Index of `day` within the rotation, always non-negative. */
      cycleIndex: (day) => {
        const diff = Math.round((startOfDay(day) - cycleAnchor) / DAY_MS);
        return ((diff % cycleDays) + cycleDays) % cycleDays;
      },
    };
  };

  const EMPTY = derive(null);
  const cache = new Map();

  /**
   * The schedule in force ON `day`. `schedules` is ordered newest-start first,
   * so the first whose range contains the day is the one that governs it.
   */
  const patternOn = (day) => {
    const hit = schedules.find(
      (s) =>
        startOfDay(s.effective_start_date) <= day
        && (s.effective_end_date == null || startOfDay(s.effective_end_date) >= day),
    );
    if (!hit) return EMPTY;
    if (!cache.has(hit)) cache.set(hit, derive(hit.schedule_pattern));
    return cache.get(hit);
  };

  const holidayByDay = new Map();
  for (const h of holidays) {
    // A half-day holiday is still a working day; only a full day removes it.
    if (h.fullDay === false) continue;
    holidayByDay.set(startOfDay(h.date).toISOString().slice(0, 10), h.name);
  }

  // HR-ATT-ONCALL-01 — keyed by day; the value is the call-in's reason.
  const callInByDay = new Map();
  for (const c of callIns) {
    callInByDay.set(startOfDay(c.date).toISOString().slice(0, 10), c.reason ?? null);
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

    // HR-ATT-ONCALL-01 — precedence: approved leave > called-in > holiday >
    // rostered off-day. A call-in beats BOTH rest rules (weekday off and
    // rotation rest) because it is a specific HR instruction for a specific
    // date, and it beats a holiday for the same reason; only approved leave
    // outranks it — the employee is not available even if HR asks.
    if (callInByDay.has(key)) {
      out.set(key, { date: day, working: true, reason: "ON_CALL", detail: callInByDay.get(key) });
      continue;
    }

    if (holidayByDay.has(key)) {
      out.set(key, { date: day, working: false, reason: "HOLIDAY", detail: holidayByDay.get(key) });
      continue;
    }

    const roster = patternOn(day);

    if (roster.offDays.has(isoDow(day))) {
      out.set(key, { date: day, working: false, reason: "OFF_DAY", detail: null });
      continue;
    }

    if (roster.hasPhase && roster.cycleOffs.has(roster.cycleIndex(day))) {
      out.set(key, { date: day, working: false, reason: "ROTATION_OFF", detail: null });
      continue;
    }

    out.set(key, {
      date: day, working: true, reason: null, detail: null, rotating: roster.rotating,
    });
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
export async function isWorkingDay({ employeeId, date, tenantId }) {
  const day = startOfDay(date);
  const map = await resolveWorkingDays({ employeeId, from: day, to: day, tenantId });
  return map.get(day.toISOString().slice(0, 10));
}

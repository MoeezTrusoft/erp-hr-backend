// src/lib/attendanceReplay.js
//
// Shared replay core for the two analysis reports: the status shadow-diff and
// the deduction dry-run.
//
// Extracted rather than copied. If the two reports sessionised punches
// separately they could disagree, and the whole point of both is to be believed
// — a status report and a money report that count different shifts are worse
// than no report at all.
//
// Read-only. Nothing here writes.
//
// HR-ATT-POLICY-01.
import prisma from "./prisma.js";
import { evaluateShift } from "./attendanceEvaluator.js";
import { resolveWorkingDays } from "../services/workingDay.service.js";

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;

export const startOfDay = (v) => { const d = new Date(v); d.setHours(0, 0, 0, 0); return d; };
export const dayKey = (d) => startOfDay(d).toISOString().slice(0, 10);

/** "HH:MM" anchored to a day; a night shift rolls its end into the next one. */
/**
 * Every shift window a roster can put on this day. One entry for a fixed
 * roster; for a rotating one (HR-ATT-ROTATING-01) every alternative, because
 * "10am/pm – 10am/pm" has no single start time.
 */
export function shiftCandidates(pattern, day) {
  const mk = (hhmm) => {
    const m = typeof hhmm === "string" ? hhmm.trim().match(/^(\d{1,2}):(\d{2})/) : null;
    if (!m) return null;
    const d = new Date(day);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  };
  const build = (raw) => {
    const start = mk(raw?.from);
    let end = mk(raw?.to);
    if (start && end && end <= start) end = new Date(end.getTime() + DAY_MS);
    return { start, end };
  };

  const rotating = Array.isArray(pattern?.rotatingShifts) ? pattern.rotatingShifts : null;
  if (rotating?.length) return rotating.map(build).filter((s) => s.start);
  const single = build(pattern?.shift);
  return single.start ? [single] : [];
}

/**
 * The shift window for a day. `anchor` is the arrival that day, and for a
 * rotating roster it decides WHICH window applies: a 22:03 punch is an on-time
 * night start, not a twelve-hour-late day start. Without an anchor the first
 * window is used — that path only feeds tomorrow's check-out cutoff, where no
 * arrival exists yet.
 */
export function shiftFor(pattern, day, anchor) {
  const options = shiftCandidates(pattern, day);
  if (!options.length) return { start: null, end: null };
  if (options.length === 1 || !anchor) return options[0];

  const t = new Date(anchor).getTime();
  let best = null;
  for (const opt of options) {
    // Compare across midnight: a 23:50 punch is 10 minutes from a 00:00 start.
    let d = Math.abs(t - opt.start.getTime());
    d = Math.min(d, Math.abs(d - DAY_MS));
    if (!best || d < best.d) best = { d, opt };
  }
  return best.opt;
}

/**
 * Group punches into shifts by ANCHORING THEM TO THE ROSTER.
 *
 * The previous rule — start a new shift whenever two punches are more than N
 * hours apart — cannot work here. Shifts run 12 to 16 hours (Abdul Rasool
 * 06:49-19:04, Rustam 17:37-09:27), so any gap small enough to separate two
 * shifts is also small enough to cut one shift in half. At 11h it split 12h+
 * shifts and manufactured one orphan arrival plus one orphan departure each
 * time; at 13h it merged sparse employees into 756-hour "shifts". Measured
 * against HR's reconciled record: gap-based grouping reported ~50% of shifts
 * incomplete where HR has 98% complete.
 *
 * So each punch is assigned to the rostered shift window it belongs to, which
 * is what HR does by hand. Employees with no roster fall back to calendar day.
 *
 * Direction: the device code is trusted as a HINT but the position decides.
 * People genuinely press the wrong key — Abdul Rasool's 06:42 arrival on 2 Aug
 * is stamped Check-Out. The first punch of a shift is the arrival and the last
 * is the departure; where that contradicts the device, the punch is corrected
 * and a warning is recorded for HR to confirm or overturn.
 */
export function sessioniseByRoster(punches, pattern, { windowHours = 5 } = {}) {
  const sorted = [...punches].sort((a, b) => a.punchedAt - b.punchedAt);
  if (!sorted.length) return [];

  const hasRoster =
    Boolean(pattern?.shift?.from && pattern?.shift?.to) ||
    Boolean(Array.isArray(pattern?.rotatingShifts) && pattern.rotatingShifts.length);
  const groups = new Map();

  for (const p of sorted) {
    let key = dayKey(p.punchedAt);

    if (hasRoster) {
      // The shift may have started yesterday, today or tomorrow relative to the
      // punch — a 22:00 start read at 01:00 belongs to yesterday's shift.
      let best = null;
      for (const offset of [-1, 0, 1]) {
        const anchor = new Date(p.punchedAt.getTime() + offset * DAY_MS);
        // A rotating roster offers more than one window per day; the punch has
        // to be tried against each, or a night arrival gets pulled onto the
        // wrong day by the day-shift window.
        for (const { start, end } of shiftCandidates(pattern, startOfDay(anchor))) {
          if (!start || !end) continue;
          const from = start.getTime() - windowHours * 60 * MIN_MS;
          const to = end.getTime() + windowHours * 60 * MIN_MS;
          const t = p.punchedAt.getTime();
          if (t < from || t > to) continue;
          // Measure to the edge this punch is meant to be near. A 10:00
          // departure sits exactly on a night shift's END and exactly on the
          // next day shift's START — scoring only against `start` hands it to
          // the wrong day and splits the night shift in two. The device's
          // direction is only a hint for the verdict, but it is good enough to
          // choose a window.
          const isOut = p.status === 1 || p.status === 5;
          const distance = Math.abs(t - (isOut ? end.getTime() : start.getTime()));
          if (!best || distance < best.distance) {
            best = { distance, key: dayKey(startOfDay(anchor)) };
          }
        }
      }
      if (best) key = best.key;
    }

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const out = [];
  for (const [key, raw] of [...groups.entries()].sort()) {
    const list = raw.sort((a, b) => a.punchedAt - b.punchedAt);
    const corrections = [];

    // Position decides direction; the device code only raises a warning when it
    // disagrees, so HR can see what was changed and why.
    const deviceDir = (st) => (st === 0 || st === 4 ? "IN" : st === 1 || st === 5 ? "OUT" : null);

    const shaped = list.map((p, i) => {
      const positional = i === 0 ? "IN" : i === list.length - 1 ? "OUT" : "";
      const device = deviceDir(p.status);
      if (positional && device && device !== positional) {
        corrections.push({
          at: p.punchedAt,
          recordedAs: device,
          resolvedTo: positional,
          reason:
            positional === "IN"
              ? "first scan of the shift, recorded as a check-out"
              : "last scan of the shift, recorded as a check-in",
        });
      }
      return { timestamp: p.punchedAt, type: positional || device || "" };
    });

    out.push({ day: startOfDay(new Date(`${key}T00:00:00`)), punches: shaped, corrections });
  }

  return out;
}

/**
 * Every evaluated shift for one tenant in a window.
 *
 * Assumes the caller has already established the tenant context; it issues
 * ordinary model queries so RLS scopes them.
 */
export async function replayTenant({ tenantId, from, to, policy, now = new Date() }) {
  const punches = await prisma.attendanceDevicePunch.findMany({
    where: {
      tenantId,
      employeeId: { not: null },
      punchedAt: { gte: new Date(`${from}T00:00:00`), lte: new Date(`${to}T23:59:59`) },
    },
    select: { employeeId: true, punchedAt: true, status: true },
    orderBy: [{ employeeId: "asc" }, { punchedAt: "asc" }],
  });

  const byEmployee = new Map();
  for (const p of punches) {
    if (!byEmployee.has(p.employeeId)) byEmployee.set(p.employeeId, []);
    byEmployee.get(p.employeeId).push(p);
  }

  const results = [];

  for (const [employeeId, rows] of byEmployee) {
    const [schedule, working] = await Promise.all([
      // Effective-dated: pick the schedule in force ON the window, not simply
      // the newest row. Without the date filter a mid-month shift change would
      // be applied retroactively to days it never covered.
      prisma.workSchedule.findFirst({
        where: {
          employeeId,
          effective_start_date: { lte: new Date(`${to}T23:59:59`) },
          OR: [
            { effective_end_date: null },
            { effective_end_date: { gte: new Date(`${from}T00:00:00`) } },
          ],
        },
        orderBy: { effective_start_date: "desc" },
        select: { schedule_pattern: true, effective_start_date: true },
      }),
      resolveWorkingDays({
        employeeId,
        from,
        to: new Date(new Date(to).getTime() + DAY_MS),
      }),
    ]);

    for (const session of sessioniseByRoster(rows, schedule?.schedule_pattern)) {
      const day = session.day;
      const tomorrow = new Date(day.getTime() + DAY_MS);
      const tomorrowInfo = working.get(dayKey(tomorrow));
      const nextShift = shiftFor(schedule?.schedule_pattern, tomorrow);

      const verdict = evaluateShift({
        punches: session.punches,
        // The arrival anchors WHICH rotating window applies (HR-ATT-ROTATING-01).
        shift: shiftFor(schedule?.schedule_pattern, day, session.punches[0]?.punchedAt),
        policy,
        nextDay: {
          working: Boolean(tomorrowInfo?.working),
          nextShiftStart: tomorrowInfo?.working ? nextShift.start : null,
        },
        now,
      });

      results.push({ employeeId, day, verdict, corrections: session.corrections });
    }
  }

  return results;
}

/** Distinct tenants that have punches. See the note in the scripts: this MUST be
 *  a model query under SYSTEM context — $queryRaw skips the RLS extension, sets
 *  no tenant GUC, and silently returns nothing. */
export async function tenantsWithPunches(mcpCtx) {
  const rows = await mcpCtx.run({ system: true }, async () => {
    return await prisma.attendanceDevicePunch.findMany({
      where: { tenantId: { not: null } },
      distinct: ["tenantId"],
      select: { tenantId: true },
    });
  });
  return rows.map((r) => r.tenantId);
}

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
import { loadAttendanceRuntime } from "../services/attendanceSetup.service.js";

import { shiftFor, shiftCandidates } from './attendanceShift.js';
export { shiftFor, shiftCandidates };

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;

export const startOfDay = (v) => { const d = new Date(v); d.setUTCHours(0, 0, 0, 0); return d; };
export const dayKey = (d) => startOfDay(d).toISOString().slice(0, 10);

/** "HH:MM" anchored to a day; a night shift rolls its end into the next one. */
/**
 * Every shift window a roster can put on this day. One entry for a fixed
 * roster; for a rotating one (HR-ATT-ROTATING-01) every alternative, because
 * "10am/pm – 10am/pm" has no single start time.
 */
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
export function sessioniseByRoster(
  punches,
  pattern,
  // ATT-CLOSE-9H-01 (2026-10-01) — closeHours 8→9. Trusoft's 15:00–00:00
  // Moeez/Subhan crew scanned OUT at 08:30, 8.5h past the rostered end, and
  // the 8h close window refused the punch: it opened a phantom next-day
  // session and the day's real arrival then paired with IT, turning the
  // departure into the next day's check-in. HR: shifts end when the work
  // ends, never more than nine hours after. The nearest-next-start guard
  // still protects day-shift crews whose 08:30 punch is minutes from a
  // 09:00 rostered arrival.
  { windowHours = 5, dedupeSeconds = 120, closeHours = 9 } = {},
) {
  const ordered = [...punches].sort((a, b) => a.punchedAt - b.punchedAt);

  // HR-ATT-DUPLICATE-01 — one press, however many records it left.
  //
  // The MB460 repeats a scan: Khurram's every punch appears three times, some
  // four. Left alone the repeats are not merely noise, they invent shifts. The
  // first of three identical 10:11 OUTs closes the open night shift and clears
  // `open`; the second then finds nothing open, so the stateful rule below
  // reads it as an ARRIVAL and starts a session on what is a rotation rest day.
  // That session holds one punch, so it lands as MISSING_CHECKOUT or ABSENT,
  // and it comes back every time the evaluator runs.
  //
  // The window is 2 minutes: enough for a double-tap and for the 22:02/22:03
  // straddle of a slow finger, far short of two genuine events, which on a
  // 12-hour roster are hours apart.
  const sorted = [];
  const dedupeMs = dedupeSeconds * 1000;
  for (const p of ordered) {
    const prev = sorted[sorted.length - 1];
    if (prev && p.punchedAt - prev.punchedAt <= dedupeMs &&
      (!(prev.directionVerified || p.directionVerified) || prev.status === p.status)) continue;
    sorted.push(p);
  }
  if (!sorted.length) return [];

  const hasRoster =
    typeof pattern === "function" ||
    Boolean(pattern?.shift?.from && pattern?.shift?.to) ||
    Boolean(Array.isArray(pattern?.rotatingShifts) && pattern.rotatingShifts.length);
  const groups = new Map();

  // HR-ATT-SESSION-01 — a shift that is OPEN claims the punch that closes it.
  //
  // Scoring each punch independently against the nearest edge cannot work here.
  // A 10:00 scan is exactly on a night shift's END and exactly on the next day
  // shift's START, so distance alone ties every time, and whichever way the tie
  // is broken it is wrong half the time: trusting the device's status byte
  // stranded Ghulam Rasool's mis-stamped 11:27 close as a phantom next-day
  // arrival, and always preferring the earlier window swallowed genuine 10:04
  // day-shift arrivals into the previous night.
  //
  // The domain breaks the tie: you cannot arrive while you are still on shift.
  // So punches are walked in order, and while a shift is open the next punch
  // closes it. Only a punch that no open shift can account for opens a new one.
  let open = null; // { key, start, end } of the shift currently in progress
  const tol = windowHours * 60 * MIN_MS;
  const closeTol = closeHours * 60 * MIN_MS;

  /** Distance from `t` to the nearest rostered START, across a day either side. */
  const toNearestStart = (at) => {
    let best = Infinity;
    for (const offset of [-1, 0, 1]) {
      const anchor = new Date(at.getTime() + offset * DAY_MS);
      for (const { start } of shiftCandidates(pattern, startOfDay(anchor))) {
        if (start) best = Math.min(best, Math.abs(at.getTime() - start.getTime()));
      }
    }
    return best;
  };

  for (const p of sorted) {
    let key = dayKey(p.punchedAt);
    const t = p.punchedAt.getTime();

    if (hasRoster) {
      // HR-ATT-TOLERANCE-01 — a late departure still closes its own shift.
      //
      // The close window was the same 5 hours as everything else. hamza works
      // 15:00-00:00 and left at 05:06 — six minutes outside it — so the shift
      // he was closing stayed open and his scan started a session on a Saturday
      // he does not work. HR: "we don't sometimes leave on time... these next
      // day or deep night check-outs are for previous days."
      //
      // Widening it alone would be reckless: an 8-hour window on a day shift
      // reaches into the next morning and would swallow a real arrival. So past
      // the normal window a punch is only claimed while it stays nearer this
      // shift's END than to any plausible next START.
      const late = open
        && t > open.end + tol
        && t <= open.end + closeTol
        && (t - open.end) < toNearestStart(p.punchedAt);

      // HR-ATT-DIRECTION-02 (2026-10-01) — a device check-out closes the open
      // shift even past the close window's positional logic. Two guards stack
      // ahead of it: the punch must sit within nine hours of the rostered end,
      // and the session must be OPEN — i.e. a genuine earlier punch opened it.
      // The nearest-next-start test is deliberately NOT applied: Moeez's 08:30
      // OUT sits 6.5h from the next 15:00 start but 8.5h from the midnight end,
      // so "nearer the next start" reads it as an arrival — yet a device check-
      // out cannot be an arrival, and the validated device direction
      // (HR-ATT-POLICY-01: 4404 rows, zero disagreements) outranks the
      // positional heuristic. A mis-stamped genuine arrival is protected by the
      // other two guards: its own shift has usually closed already (open=null)
      // or it lands outside the nine-hour window.
      const closesByDevice = open
        && (p.status === 1 || p.status === 5)
        && t > open.end
        && t <= open.end + closeTol;

      // 1. Does this punch belong to the shift already in progress?
      if (open && ((t >= open.start - tol && t <= open.end + tol) || late || closesByDevice)) {
        key = open.key;
        // Past the rostered end, the shift is finished; a later punch is a new
        // arrival rather than a third scan of the same shift.
        if (t >= open.end) open = null;
      } else {
        // 2. Otherwise it opens a shift. Choose the window whose START it is
        //    nearest — an arrival is defined by its start, not by either edge.
        let best = null;
        for (const offset of [-1, 0, 1]) {
          const anchor = new Date(p.punchedAt.getTime() + offset * DAY_MS);
          // A rotating roster offers more than one window per day; the punch has
          // to be tried against each, or a night arrival gets pulled onto the
          // wrong day by the day-shift window.
          for (const { start, end } of shiftCandidates(pattern, startOfDay(anchor))) {
            if (!start || !end) continue;
            if (t < start.getTime() - tol || t > end.getTime() + tol) continue;
            const distance = Math.abs(t - start.getTime());
            if (!best || distance < best.distance) {
              best = {
                distance,
                key: dayKey(startOfDay(anchor)),
                start: start.getTime(),
                end: end.getTime(),
              };
            }
          }
        }
        if (best) {
          key = best.key;
          open = { key: best.key, start: best.start, end: best.end };
        }
      }
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

    // HR-ATT-DIRECTION-01 — with ONE scan, position cannot tell you anything.
    //
    // The positional rule makes the only punch the first punch, so every
    // incomplete shift was stored MISSING_CHECKOUT. Against HR's August
    // workbook that label was wrong for 23 of the 61 incomplete days: a lone
    // 22:15 scan on a 10:00-22:00 shift is a DEPARTURE, and what is missing is
    // the check-IN. HR's own times for those days sit in their check-out
    // column, matching our scan to the minute.
    //
    // The label matters because it sends HR to fill an end — filling an "out"
    // over a scan that IS the out would overwrite the day's only real
    // observation. So a lone punch is timed against the rostered window;
    // without a roster there is nothing to time it against and it stays an
    // arrival, as before.
    const loneDirection = () => {
      if (list.length !== 1) return null;
      const day = startOfDay(new Date(`${key}T00:00:00Z`));
      const t = list[0].punchedAt.getTime();
      let nearest = null;
      for (const { start, end } of shiftCandidates(pattern, day)) {
        if (!start || !end) continue;
        const toStart = Math.abs(t - start.getTime());
        const toEnd = Math.abs(t - end.getTime());
        const d = Math.min(toStart, toEnd);
        if (!nearest || d < nearest.d) nearest = { d, dir: toEnd < toStart ? "OUT" : "IN" };
      }
      return nearest?.dir ?? null;
    };
    const lone = loneDirection();

    const shaped = list.map((p, i) => {
      if (p.directionVerified) return { timestamp: p.punchedAt, type: deviceDir(p.status) || '' };
      const positional = lone ?? (i === 0 ? "IN" : i === list.length - 1 ? "OUT" : "");
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

    // HR-ATT-PRIMARY-DEVICE-01 — `punchSn` is the raw device serial per
    // session punch, position-aligned with `punches` (the evaluator's shaped
    // view drops everything but timestamp/type). The writer folds this into
    // Attendance.primary_sn / Attendance.secondary_punches: primary punches
    // are the normal case, punches on any other device are recorded
    // explicitly rather than silently merged.
    out.push({ day: startOfDay(new Date(`${key}T00:00:00Z`)), punches: shaped, corrections, punchSn: list.map((p) => p.sn ?? null) });
  }

  return out;
}

/**
 * Every evaluated shift for one tenant in a window.
 *
 * Assumes the caller has already established the tenant context; it issues
 * ordinary model queries so RLS scopes them.
 */
export async function replayTenant({ tenantId, from, to, policy, now = new Date(), employeeIds, db = prisma }) {
  // HR-ATT-WINDOW-01 — reach a day either side so a shift that straddles the
  // boundary keeps both ends.
  //
  // A night shift beginning 31 July 22:00 and ending 1 August 10:00 has its
  // arrival outside an August window. Querying [from, to] exactly drops it, and
  // the lone morning OUT then opens a session of its own that evaluates to
  // MISSING_CHECKOUT — a shift nobody failed to close, manufactured by the
  // range. On production August data that was 8 of the 37 rows on 08-01, where
  // every other day of the month sits at 0-5%.
  //
  // MISSING_* writes day_credit NULL and requires_regularization, so payroll
  // HOLDS the day: left alone, a month boundary parks a day's pay for everyone
  // on nights.
  //
  // The extra day exists only to COMPLETE shifts belonging to the window;
  // sessions are filtered back to [from, to] below so no row is written outside
  // the range the caller asked for.
  const windowStart = new Date(new Date(`${from}T00:00:00Z`).getTime() - DAY_MS);
  const windowEnd = new Date(new Date(`${to}T23:59:59Z`).getTime() + DAY_MS);

  const runtime = await loadAttendanceRuntime({tenantId,from:windowStart,to:windowEnd,db});
  const punches = await db.attendanceDevicePunch.findMany({
    where: {
      tenantId,
      employeeId: employeeIds ? { in: employeeIds } : { not: null },
      punchedAt: { gte: windowStart, lte: windowEnd },
    },
    select: { employeeId: true, punchedAt: true, status: true, sn: true, directionVerified: true },
    orderBy: [{ employeeId: "asc" }, { punchedAt: "asc" }],
  });

  // HR-PAY-ELIG-01 — people who are not on payroll are not evaluated.
  //
  // Everyone scans on the same device, so without this the evaluator derives
  // attendance, absences and deduction forecasts for contractors, FOC staff and
  // anyone else HR excludes. That output is meaningless and has been mistaken
  // for signal — those rows were the largest block left in August's
  // reconciliation gap, against people HR's workbook has no column for.
  //
  // Asked as an EXCLUSION list rather than an inclusion one: only an explicit
  // `false` drops somebody. A missing flag, or a row predating the column,
  // stays included — nobody stops being paid because a backfill missed them.
  const excluded = new Set(
    (await db.employee.findMany({
      where: { tenant_id: tenantId, payroll_included: false },
      select: { id: true },
    })).map((e) => e.id),
  );

  const byEmployee = new Map();
  for (const p of punches) {
    if (excluded.has(p.employeeId)) continue;
    if (!byEmployee.has(p.employeeId)) byEmployee.set(p.employeeId, []);
    byEmployee.get(p.employeeId).push(p);
  }

  const results = [];

  for (const [employeeId, rows] of byEmployee) {
    const patternForDay = day => runtime.resolve(employeeId,day).pattern;
    for (const session of sessioniseByRoster(rows, patternForDay)) {
      const day = session.day;
      // The padding day is for context only — never for output.
      const key = dayKey(day);
      if (key < from || key > to) continue;

      // HR-ATT-OFFDAY-01 — a lone scan on a rostered off day is not a shift.
      //
      // Without this, one punch on somebody's weekend opens a session, holds a
      // single punch and lands as MISSING_CHECKOUT: a chargeable,
      // payroll-blocking row on a day nobody was rostered. It was deleted by
      // hand eleven times and rebuilt itself on the next re-derivation, because
      // the punches were still there and nothing asked whether the day was a
      // working one.
      //
      // Per HR these scans are either the tail of the previous evening's shift
      // — people do not always leave on time — or habit ("muscle memory") on a
      // day off. Neither is a shift.
      //
      // A complete PAIR is kept: working a rest day is real, and must stay
      // visible and payable. And an absent verdict from the resolver is not
      // permission to drop anything — only an explicit `working === false`
      // suppresses, so an employee with no roster keeps every day they scan on.
      const dayInfo = runtime.resolve(employeeId,day,session.punches[0]?.timestamp);
      if(['NOT_ELIGIBLE','MANUAL_MONTHLY'].includes(dayInfo.reason))continue;
      if(dayInfo.working == null) {
        results.push({employeeId,day,setupVersion:dayInfo.setupVersion,setupSnapshot:dayInfo,verdict:{status:"SETUP_REQUIRED",dayCredit:null,requiresRegularization:true,anomalies:[],workedMinutes:0,checkIn:session.punches.find(p=>p.type==='IN')?.timestamp??null,checkOut:session.punches.findLast(p=>p.type==='OUT')?.timestamp??null},corrections:[]});
        continue;
      }
      if (dayInfo?.working === false && session.punches.length < 2) continue;
      const tomorrow = new Date(day.getTime() + DAY_MS);
      const tomorrowInfo = runtime.resolve(employeeId,tomorrow);
      const nextShift = shiftFor(patternForDay, tomorrow);

      const verdict = evaluateShift({
        punches: session.punches,
        // The arrival anchors WHICH rotating window applies (HR-ATT-ROTATING-01).
        // ATT-ROT-ANCHOR-01 — session punches are the SHAPED view
        // ({ timestamp, type }), so the anchor is `timestamp`, not `punchedAt`.
        // Reading `punchedAt` off a shaped punch is always undefined, which made
        // shiftFor fall back to the FIRST rotating window — so every rotating
        // employee was scored against the DAY window (10:00–22:00) even on a
        // night shift, turning a 21:59 night arrival into "11h59 late" and a
        // half-day deduction.
        shift: dayInfo.shift,
        policy: policy ?? dayInfo.policy,
        nextDay: {
          working: Boolean(tomorrowInfo?.working),
          nextShiftStart: tomorrowInfo?.working ? nextShift.start : null,
        },
        now,
      });
      if(dayInfo.reason==='PAID_NO_PUNCH')Object.assign(verdict,{status:'PRESENT',dayCredit:1,requiresRegularization:false,anomalies:[]});

      results.push({ employeeId, day, verdict, setupVersion:dayInfo.setupVersion, setupSnapshot:dayInfo, corrections: session.corrections, punchSn:session.punchSn });
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

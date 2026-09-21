// src/services/timesheetReport.service.js
//
// HR → Timesheet read screen backend: KPI cards, two graphs, and the
// check-in/out table.
//
// AUTHORITY: every read uses the STORED Attendance.status (enum
// StatusAttendance: PRESENT | ABSENT | LATE | HALF_DAY | MISSING_CHECKIN |
// MISSING_CHECKOUT | WEEKLY_OFF | HOLIDAY | ON_LEAVE) and STORED
// Attendance.work_mode ("Remote" | "Onsite" | "Hybrid"). We NEVER re-derive
// status from check_in/check_out — the stored value is the source of truth
// (it was computed at punch time with the tenant's shift rules).
//
// TENANCY: Attendance is a C.2 (camelCase `tenantId`) FORCE-RLS table, so its
// reads fold the tenant via scopedWhere(tenantId, where). Employee carries the
// snake_case `tenant_id` column, so employee counts use scopedEmployeeWhere.
//
// PERIOD DEFAULT: when from/to (or month) are omitted we default to the CURRENT
// calendar month, computed from new Date().
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import logger from "../lib/logger.js";

// Statuses that count as "showed up" for a working day.
const PRESENT_STATUSES = ["PRESENT", "LATE", "HALF_DAY"];
// Statuses that count as a late arrival.
const LATE_STATUSES = ["LATE", "HALF_DAY"];

// UI-FIX-2026-09-15 (#9) — stored statuses that mean a person was rostered in
// but NOT satisfactorily present. The weekly tooltip lists these by name, so
// "98% with no absentees" becomes impossible: the gap IS listed.
const ATTENDANCE_PROBLEM_STATUSES = new Set(["ABSENT", "MISSING_CHECKIN", "MISSING_CHECKOUT"]);
// HR-RECON-02 — days nobody was rostered in. These come OUT of every
// denominator: they are not days somebody failed to attend, they are days
// nobody was due. Same set the reconciliation report excludes, so the two
// cannot drift apart.
const NON_WORKING_STATUSES = ["WEEKLY_OFF", "HOLIDAY", "ON_LEAVE"];
// TS-WEEKLY-01 (operator item 4, 2026-09-17) — a day with an UNRESOLVED
// missing punch is neither present nor a verdict: it is a question the
// employee is still answering. Counting it expected-but-not-present is what
// held the weekly bars at 98/96% while the tooltip (ABSENT-only, same rule as
// the Absentees KPI) showed zero absentees. Unresolved MISSING_* drops out of
// BOTH numerator and denominator; a RESOLVED one (punch filled) is a normal
// working day again. Same asymmetry the KPI tile already uses, so the bar and
// the tile can never disagree.
const UNRESOLVED_MISSING_STATUSES = ["MISSING_CHECKIN", "MISSING_CHECKOUT"];
// work_mode values that count as remote/WFH.
const REMOTE_MODES = ["Remote", "Hybrid"];

// HR-ATT-ELIG-01 (2026-09-14) — who may appear in a timesheet report at all.
//
// The KPIs, both graphs and the table previously counted EVERY employee row
// (and, via the unfiltered ABSENT store, rows for people who had already
// left). Reported symptoms this fixes: "terminated employees (Shiza, Afzal,
// Affan) participate as absentees" and Meesam counted during his Aug 20 –
// Sep 3 termination gap. Rules:
//   * Employee.payroll_included = false → HR excluded them from attendance
//     and payroll altogether (HR-PAY-ELIG-01). Never count them.
//   * Employee.status = 'Inactive' → separated. Their historic rows stay in
//     the DB (payroll history), but they must not surface as today's
//     absentees. Obaid (terminated 2026-09-08) was charged again on the 9th.
//   * Employment periods: an employee whose termination date has passed (last
//     period endDate before the report window) is out; Meesam's Aug gap is
//     covered by the ABSENT-row cleanup, since the rows already exist.
// The single source of this predicate is eligibilityGuard() below so the
// KPI count, both graphs and the table cannot drift apart.
async function eligibilityEmployeeIds(tenantId, windowStart) {
  const employees = await prisma.employee.findMany({
    where: scopedEmployeeWhere(tenantId, {
      payroll_included: true,
    }),
    select: { id: true, status: true },
  });
  const ids = employees.map((e) => e.id);

  // TIMESHEET-ELIG-02 (2026-09-16) — employment SPANS, not "separated = gone".
  //
  // The old rule dropped an employee whose LAST period ended before the window,
  // and separately dropped everyone with status Inactive. Both halves erased
  // LEGITIMATE in-window history:
  //   * Obaid, terminated 2026-09-08: his Sep 1–8 rows must still show in the
  //     September table ("Obaid's timesheet is not available for September").
  //   * Meesam, suspended Aug 20 and re-hired Sep 4: his OLD period ends Aug 20,
  //     so "last period before the window" dropped him from September entirely
  //     even though his re-hire period covers it from Sep 4.
  //
  // New rules:
  //   * An employee stays in the id set when ANY employment period intersects
  //     the window (open endDate, or endDate >= windowStart), or when they have
  //     no period rows at all (legacy employees predate the model).
  //   * `status: Inactive` no longer removes the id — the SPAN decides. Only an
  //     Inactive employee whose every period ended BEFORE the window drops, so
  //     a data gap can never resurface a leaver forever.
  //
  // Consumers additionally filter ROWS per-day with employmentEndByEmployee:
  // a row dated after the person's last period end is not theirs to show, and
  // a not-yet-re-hired person's pre-hire days stay excluded by their periods'
  // absence (no row should exist there anyway).
  let employmentEndByEmployee = new Map();
  let periodExcluded = new Set();
  if (ids.length) {
    const rows = await prisma.employmentPeriod.findMany({
      where: { employeeId: { in: ids } },
      select: { employeeId: true, startDate: true, endDate: true },
    });
    const hasOpenOrFuture = new Set();
    const lastEnd = new Map();
    for (const p of rows) {
      if (p.endDate == null || p.endDate.getTime() >= windowStart.getTime()) {
        hasOpenOrFuture.add(p.employeeId);
      }
      if (p.endDate != null) {
        const prev = lastEnd.get(p.employeeId);
        if (!prev || p.endDate.getTime() > prev.getTime()) lastEnd.set(p.employeeId, p.endDate);
      }
    }
    const win = windowStart.getTime();
    for (const e of employees) {
      const personRows = rows.filter((p) => p.employeeId === e.id);
      if (!personRows.length) {
        // No period rows at all. Legacy behaviour: Active stays, Inactive drops.
        if (e.status === "Inactive") periodExcluded.add(e.id);
        continue;
      }
      if (hasOpenOrFuture.has(e.id)) {
        // A period covers (or outlives) the window start → eligible. Their
        // per-day span cap is their last endDate, if any (rehire case: the
        // old spell's end caps nothing because the open period is later —
        // lastEnd still holds the OLD spell, so only cap when the person has
        // NO open period).
        if (e.status === "Inactive" || lastEnd.has(e.id)) {
          const hasOpen = personRows.some((p) => p.endDate == null);
          if (!hasOpen) employmentEndByEmployee.set(e.id, lastEnd.get(e.id) ?? null);
        }
        continue;
      }
      // Every period ended before the window start.
      if (e.status === "Inactive") {
        periodExcluded.add(e.id);
      } else {
        // Not marked Inactive but all periods closed pre-window: keep visible
        // up to the last end (span-capped) rather than vanish mid-history.
        employmentEndByEmployee.set(e.id, lastEnd.get(e.id) ?? null);
      }
    }
  }
  const eligible = ids.filter((id) => !periodExcluded.has(id));
  // Empty list must match NOTHING, not everything: Prisma treats `in: []` as
  // a guaranteed-empty set, which is exactly what we want — keep [-1] out.
  return { eligible, excludedCount: periodExcluded.size, employmentEndByEmployee };
}

/**
 * TIMESHEET-ELIG-02 — drop rows dated AFTER the employee's employment ended
 * (per-day span enforcement). Rows up to and including the end date stay.
 */
function filterRowsByEmploymentSpan(rows, employmentEndByEmployee) {
  if (!employmentEndByEmployee?.size) return rows;
  return rows.filter((r) => {
    const end = employmentEndByEmployee.get(r.employeeId);
    return end == null || r.date.getTime() <= end.getTime();
  });
}

// ── Date helpers ────────────────────────────────────────────────────────────

// Start of a UTC day.
function startOfDay(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

// End of a UTC day (23:59:59.999).
function endOfDay(d) {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}

// Parse an ISO date string to a Date, or null when absent/invalid.
function parseDate(raw) {
  if (raw == null || raw === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Resolve a [from,to] window. Defaults to the current calendar month.
// Exported for timesheetSubmission.service (TS-SUBMIT-01) so the submission
// window and every report window are computed by the same rule.
export function resolvePeriod(from, to) {
  const now = new Date();
  const parsedFrom = parseDate(from);
  const parsedTo = parseDate(to);
  const start = parsedFrom
    ? startOfDay(parsedFrom)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = parsedTo
    ? endOfDay(parsedTo)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { from: start, to: end };
}

// Resolve a "YYYY-MM" month string to its calendar-month bounds. Defaults to
// the current month when absent/invalid.
function resolveMonth(month) {
  const now = new Date();
  let year = now.getUTCFullYear();
  let mon = now.getUTCMonth(); // 0-based
  if (typeof month === "string") {
    const m = month.match(/^(\d{4})-(\d{2})$/);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]) - 1;
      if (Number.isFinite(y) && mo >= 0 && mo <= 11) {
        year = y;
        mon = mo;
      }
    }
  }
  const start = new Date(Date.UTC(year, mon, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, mon + 1, 0, 23, 59, 59, 999));
  const label = `${year}-${String(mon + 1).padStart(2, "0")}`;
  return { year, mon, start, end, label };
}

// HR-RECON-02 — isWorkingDay() and countWorkingDays() lived here and hardcoded
// Mon-Sat. Both are gone rather than left unused: whether a day is a working
// one is a property of that employee's ROSTER, never of the weekday, and a
// helper that says otherwise is an invitation to reintroduce the bug. What a
// day was is now read from the stored status (HR-ATT-STATUS-01).

// Split a calendar month into successive Week 1..N chunks. Each week runs from
// its first day up to the following Sunday (inclusive) so a "week" is a
// Mon–Sun calendar week clipped to the month bounds. The first chunk starts on
// day 1 of the month regardless of weekday.
function monthWeeks(monthStart, monthEnd) {
  // UI-FIX-2026-09-14 — COHERENT WEEKS. The old chunking clipped Mon–Sun weeks
  // to the month edge, so a month opening mid-week produced a 1–2 day "Week 1"
  // stub: August 2026 (starts Saturday) rendered SIX weeks with Week 1 = 0%
  // and Week 6 = a lone Aug 31. Rule now: an edge chunk shorter than 4 days
  // MERGES into its neighbour (leading stub extends week 1, trailing stub
  // extends the last week), so every month yields 4–5 honest weeks.
  const raw = [];
  let cursor = startOfDay(monthStart);
  const last = startOfDay(monthEnd);
  while (cursor.getTime() <= last.getTime()) {
    // End of this week = the coming Sunday (getUTCDay 0), clipped to month end.
    const weekEnd = new Date(cursor);
    const dow = weekEnd.getUTCDay();
    const daysToSunday = (7 - dow) % 7;
    weekEnd.setUTCDate(weekEnd.getUTCDate() + daysToSunday);
    const clippedEnd = weekEnd.getTime() > last.getTime() ? new Date(last) : weekEnd;
    raw.push({ from: startOfDay(cursor), to: endOfDay(clippedEnd) });
    cursor = startOfDay(clippedEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const weeks = [];
  for (let i = 0; i < raw.length; i++) {
    const spanDays = Math.round((raw[i].to.getTime() - raw[i].from.getTime()) / (24 * 3600 * 1000)) + 1;
    const isFirst = weeks.length === 0;
    const isLast = i === raw.length - 1;
    if (spanDays < 4 && isFirst && raw.length > 1) {
      // Leading stub: fold into the NEXT chunk by extending this one's end.
      raw[i + 1].from = raw[i].from;
      continue; // drop this chunk; next iteration carries the merged span
    }
    if (spanDays < 4 && isLast && weeks.length > 0) {
      // Trailing stub: extend the previous week's end over it.
      weeks[weeks.length - 1].to = raw[i].to;
      continue;
    }
    weeks.push({ from: raw[i].from, to: raw[i].to });
  }
  return weeks.map((w, i) => ({ label: `Week ${i + 1}`, from: w.from, to: w.to }));
}

// Map a date to its Week N label within the month's week chunks.
function weekLabelFor(date, weeks) {
  const t = date.getTime();
  for (const w of weeks) {
    if (t >= w.from.getTime() && t <= w.to.getTime()) return w.label;
  }
  return weeks.length ? weeks[weeks.length - 1].label : "Week 1";
}

// ── KPIs ────────────────────────────────────────────────────────────────────

/**
 * Timesheet KPI cards over [from,to] (default = current calendar month).
 *
 * DEFINITIONS (computed from the STORED status/work_mode):
 *   totalEmployees : count of tenant Employee rows (scopedEmployeeWhere).
 *   present        : DISTINCT employeeIds that showed up — status in
 *                    (PRESENT, LATE, HALF_DAY) at least once in the window.
 *   lateArrivals   : COUNT of Attendance ROWS with status in (LATE, HALF_DAY).
 *   wfhRemote      : DISTINCT employeeIds with work_mode in ("Remote","Hybrid").
 *   absentees      : DISTINCT employeeIds with status ABSENT.
 *
 * @param {{tenantId:string|null, from?:string, to?:string}} args
 * @returns {Promise<{present:number,lateArrivals:number,wfhRemote:number,absentees:number,totalEmployees:number,period:{from:string,to:string}}>}
 */
export async function getTimesheetKpis({ tenantId, from, to, employeeId, _withDeltas = true }) {
  const period = resolvePeriod(from, to);

  // HR-FE-UNBLOCK-01 — optional single-employee scope, so a person's own
  // profile can show their own KPIs. Omitted keeps the tenant-wide behaviour
  // every existing caller relies on.
  const scopedEmployeeId = employeeId == null ? null : Number(employeeId);

  // HR-ATT-ELIG-01 — total headcount and every set below count ELIGIBLE
  // employees only (tenant-scoped, payroll-included, not separated, not
  // terminated before the window). Without this, separated people surfaced as
  // today's absentees forever.
  const { eligible, employmentEndByEmployee } = await eligibilityEmployeeIds(tenantId, period.from);
  const eligibleFilter = scopedEmployeeId == null
    ? { employeeId: { in: eligible } }
    : { employeeId: scopedEmployeeId };

  // `rows` must be rebindable: TIMESHEET-ELIG-02 span-caps it in place below.
  let rows;
  const totalEmployees = await prisma.employee.count({
    where: scopedEmployeeWhere(
      tenantId,
      scopedEmployeeId == null ? { id: { in: eligible } } : { id: scopedEmployeeId },
    ),
  });
  rows = await prisma.attendance.findMany({
    where: scopedWhere(tenantId, { ...eligibleFilter, date: { gte: period.from, lte: period.to } }),
    select: { employeeId: true, status: true, work_mode: true, date: true },
  });

  // TIMESHEET-ELIG-02 — rows past the person's employment end never count
  // (Obaid's post-termination rows, if any survive, stay invisible).
  rows = filterRowsByEmploymentSpan(rows, employmentEndByEmployee);

  const presentEmp = new Set();
  const wfhEmp = new Set();
  const absentEmp = new Set();
  let lateArrivals = 0;

  for (const r of rows) {
    if (PRESENT_STATUSES.includes(r.status)) presentEmp.add(r.employeeId);
    if (LATE_STATUSES.includes(r.status)) lateArrivals += 1;
    if (r.status === "ABSENT") absentEmp.add(r.employeeId);
    if (r.work_mode && REMOTE_MODES.includes(r.work_mode)) wfhEmp.add(r.employeeId);
  }

  // availableShifts (operator item 11, 2026-09-15) — the true denominator:
  // every rostered shift the tenant OWED in the window, counting each stored
  // row once. Rows the roster never owed (rest days, holidays, leaves) are
  // excluded, and employment spans are enforced by the writer (separated
  // employees stop gaining rows). Feeds the FE "X / Y shifts" denominators.
  const availableShifts = rows.reduce((n, r) => {
    if (NON_WORKING_STATUSES.includes(r.status)) return n;
    return n + 1;
  }, 0);

  // Operator item 5 (2026-09-15) — machine-detected exceptions MINUS the ones
  // with their own tiles (absent + late arrivals are LATE_CHECKIN/ABSENT
  // anomalies). Backed by attendance_anomalies, which the evaluator now
  // persists (HR-ATT-ANOM-PERSIST-01) — before that this count was
  // structurally zero.
  // Guarded: some callers (unit tests) inject a Prisma stub without the
  // anomaly delegate; production always has it.
  const anomalies = prisma.attendanceAnomaly?.count
    ? await prisma.attendanceAnomaly.count({
        where: scopedWhere(tenantId, {
          ...eligibleFilter,
          date: { gte: period.from, lte: period.to },
          type: { notIn: ["ABSENT", "LATE_CHECKIN"] },
        }),
      })
    : 0;

  // Operator item 10 (2026-09-15) — each tile carries a vs-last-month delta
  // (percentage, signed). No baseline (previous value 0) → null, the FE shows
  // "–". The window is mirrored: same span immediately before this one. The
  // baseline call passes _withDeltas:false — otherwise this would recurse
  // forever.
  let deltas = null;
  if (_withDeltas) {
    const spanMs = period.to.getTime() - period.from.getTime();
    const prev = await getTimesheetKpis({
      tenantId,
      from: new Date(period.from.getTime() - spanMs - 1).toISOString(),
      to: new Date(period.from.getTime() - 1).toISOString(),
      employeeId,
      _withDeltas: false,
    });
    const pct = (cur, before) =>
      before > 0 ? Math.round(((cur - before) / before) * 100) : null;
    deltas = {
      absentees: pct(absentEmp.size, prev.absentees),
      lateArrivals: pct(lateArrivals, prev.lateArrivals),
      wfhRemote: pct(wfhEmp.size, prev.wfhRemote),
      anomalies: pct(anomalies, prev.anomalies ?? 0),
    };
  }

  return {
    present: presentEmp.size,
    lateArrivals,
    wfhRemote: wfhEmp.size,
    absentees: absentEmp.size,
    totalEmployees,
    availableShifts,
    anomalies,
    deltas,
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
  };
}

// ── GRAPH 1: weekly attendance % (horizontal bar) ───────────────────────────

/**
 * Weekly attendance percentage for the month (default current month).
 *
 * For each Mon–Sun week chunk of the month:
 *   presentDays  = COUNT of Attendance rows in that week with status in
 *                  (PRESENT, LATE, HALF_DAY).
 *   expectedDays = COUNT of rows in that week that are NOT WEEKLY_OFF,
 *                  HOLIDAY or ON_LEAVE — the days somebody was rostered in.
 *   attendancePct = round(presentDays / expectedDays * 100), 0 on divide-by-zero.
 *
 * @param {{tenantId:string|null, month?:string}} args
 * @returns {Promise<{month:string, weeks:Array<{label:string,from:string,to:string,attendancePct:number}>}>}
 */
/**
 * UI-FIX-2026-09-14 (operator item 5) — coherent per-day month grid for the
 * "My attendance" heatmap. The FE derived it from the first 100 rows of the
 * table fetch, so late pages silently dropped days and the grid disagreed
 * with the charts. Here every calendar day of the month comes from the same
 * STORED statuses the KPIs/charts use, so all widgets on the screen agree.
 *
 * Per day:
 *   present = rows with a working status (PRESENT | LATE | HALF_DAY)
 *   absent  = ABSENT rows
 *   weekend / holiday / onLeave = the respective non-working counts
 *   noData = true only when NO row exists at all for that day (future days,
 *            or a pre-import gap) — the heatmap can render it distinctly.
 *
 * @param {{tenantId:string|null, month?:string, employeeId?:string|number}} args
 * @returns {Promise<{month:string, days:Array<{date:string,day:number,present:number,absent:number,weekend:number,holiday:number,onLeave:number,total:number,noData:boolean}>}>}
 */
export async function getAttendanceMonthGrid({ tenantId, month, employeeId }) {
  const { start, end, label } = resolveMonth(month);
  const where = { date: { gte: start, lte: end } };
  let gridSpanEnds = null; // TIMESHEET-ELIG-02 span caps (tenant-wide path only)
  const asNum = employeeId != null ? Number(employeeId) : null;
  if (asNum != null && Number.isFinite(asNum)) where.employeeId = asNum;
  else if (employeeId) where.employeeId = employeeId;
  else {
    const { eligible, employmentEndByEmployee } = await eligibilityEmployeeIds(tenantId, start);
    where.employeeId = { in: eligible };
    gridSpanEnds = employmentEndByEmployee;
  }

  let rows = await prisma.attendance.findMany({
    where: scopedWhere(tenantId, where),
    select: { date: true, status: true, employee: { select: { id: true, first_name: true, last_name: true, employee_code: true } } },
  });
  // TIMESHEET-ELIG-02 — span-cap before daily aggregation.
  rows = filterRowsByEmploymentSpan(rows, gridSpanEnds);

  const byDay = new Map();
  for (const r of rows) {
    const key = startOfDay(r.date).toISOString().slice(0, 10);
    const bucket = byDay.get(key) ?? {
      present: 0,
      absent: 0,
      weekend: 0,
      holiday: 0,
      onLeave: 0,
      total: 0,
      absentees: [],
    };
    bucket.total += 1;
    if (PRESENT_STATUSES.includes(r.status)) bucket.present += 1;
    else if (r.status === "ABSENT") {
      bucket.absent += 1;
      // TIMESHEET-ABSENTEE-02 — per-day names for the heatmap tooltip
      // (operator item 3): who was absent ON THIS DAY, ABSENT-only, same rule
      // as the weekly tooltip and the KPI tile.
      if (r.employee) {
        bucket.absentees.push({
          id: r.employee.id,
          name: [r.employee.first_name, r.employee.last_name].filter(Boolean).join(" ") || r.employee.employee_code,
        });
      }
    }
    else if (r.status === "WEEKLY_OFF") bucket.weekend += 1;
    else if (r.status === "HOLIDAY") bucket.holiday += 1;
    else if (r.status === "ON_LEAVE") bucket.onLeave += 1;
    byDay.set(key, bucket);
  }

  const days = [];
  const cur = startOfDay(start);
  const last = startOfDay(end);
  while (cur.getTime() <= last.getTime()) {
    const key = cur.toISOString().slice(0, 10);
    const b = byDay.get(key);
    days.push({
      date: key,
      day: cur.getUTCDate(),
      present: b?.present ?? 0,
      absent: b?.absent ?? 0,
      weekend: b?.weekend ?? 0,
      holiday: b?.holiday ?? 0,
      onLeave: b?.onLeave ?? 0,
      total: b?.total ?? 0,
      absentees: b?.absentees ?? [],
      noData: !b,
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return { month: label, days };
}

export async function getAttendanceSummaryWeekly({ tenantId, month }) {
  const { start, end, label } = resolveMonth(month);
  const weeks = monthWeeks(start, end);

  // HR-RECON-02 — every row, so the denominator can be DERIVED.
  //
  // This used to fetch only PRESENT_STATUSES and compute
  // expectedDays = totalEmployees * Mon-Sat days. Both halves were wrong: the
  // fleet's rosters are Tue+Fri, Mon+Wed, Tue+Thu, Fri+Sat, Sat+Mon,
  // Tue+Wed+Thu and 3-day rotations, and Sunday is a working day for the whole
  // night-shift population. A Sunday shift counted in the numerator with no
  // matching denominator, and everyone's rostered days off counted as days
  // they were expected in. Both errors flatter the number.
  let rows = await prisma.attendance.findMany({
    where: scopedWhere(tenantId, {
      // HR-ATT-ELIG-01 — eligible employees only (see getTimesheetKpis).
      employeeId: { in: (await eligibilityEmployeeIds(tenantId, start)).eligible },
      date: { gte: start, lte: end },
    }),
    select: { date: true, status: true, employee: { select: EMPLOYEE_SELECT } },
  });
  // TIMESHEET-ELIG-02 — span-cap rows before any week math (see getTimesheetKpis).
  rows = filterRowsByEmploymentSpan(
    rows,
    (await eligibilityEmployeeIds(tenantId, start)).employmentEndByEmployee,
  );

  const out = weeks.map((w) => {
    const inWeek = rows.filter(
      (r) => r.date.getTime() >= w.from.getTime() && r.date.getTime() <= w.to.getTime(),
    );
    const presentDays = inWeek.filter((r) => PRESENT_STATUSES.includes(r.status)).length;
    // Expected = the days somebody was actually rostered in, straight from what
    // the day was recorded as. Same rule the reconciliation report uses, so the
    // graph and the report cannot disagree. TS-WEEKLY-01: unresolved missing-
    // punch days are excluded from the denominator (see the constant above).
    const expectedDays = inWeek.filter(
      (r) => !NON_WORKING_STATUSES.includes(r.status) && !UNRESOLVED_MISSING_STATUSES.includes(r.status),
    ).length;
    // TS-WEEKLY-02 — a week with NO expected days is NO DATA, not 0%: a
    // future week of the current month read as a 0% bar and implied catastrophic
    // absence. null renders as no bar (FE adapter passes it through); 0% stays
    // reserved for a real week where nobody made it in.
    const attendancePct = expectedDays > 0 ? Math.round((presentDays / expectedDays) * 100) : null;
    // UI-FIX-3 (2026-09-14) — hover tooltip lists the week's problem days by
    // name. UI-FIX-2026-09-15 (#9) — an "absentee" for the tooltip is anything
    // TIMESHEET-ABSENTEE-02 (operator item 2, 2026-09-16) — the tooltip lists
    // STRICT ABSENT days only, the same rule the Absentees KPI tile uses. The
    // previous "any problem status" source (MISSING_CHECKIN/MISSING_CHECKOUT
    // included) listed Samina's checkout anomaly and Abdullah/Faiq/Shahzaib's
    // regularization-pending days as "absentees" — those are anomalies an
    // employee is already answering, not days the company owes nobody. The
    // weekly percentage itself is untouched. DISTINCT per employee: one person
    // absent 3 days appears once, with the days missed.
    const byEmployee = new Map();
    for (const r of inWeek) {
      if (r.status !== "ABSENT" || !r.employee) continue;
      const entry = byEmployee.get(r.employee.id) ?? {
        id: r.employee.id,
        name: fullName(r.employee),
        days: [],
      };
      entry.days.push(r.date.toISOString().slice(0, 10));
      byEmployee.set(r.employee.id, entry);
    }
    const absentees = Array.from(byEmployee.values()).sort((a, b) =>
      (a.name ?? "").localeCompare(b.name ?? ""),
    );
    return {
      label: w.label,
      from: w.from.toISOString(),
      to: w.to.toISOString(),
      attendancePct,
      absentees,
    };
  });

  return { month: label, weeks: out };
}

// ── GRAPH 2: day-wise absenteeism trend ─────────────────────────────────────

/**
 * Day-wise absenteeism percentage for the month (default current month),
 * tagged by week label.
 *
 * We emit every day SOMEBODY WAS ROSTERED ON, which is not the same as Mon-Sat:
 * Sunday is a working day for the night-shift population, and plenty of people
 * are off midweek. Per day:
 *   rostered        = DISTINCT employeeIds with a row that is not WEEKLY_OFF,
 *                     HOLIDAY or ON_LEAVE.
 *   absentEmployees = DISTINCT employeeIds with status ABSENT on that date.
 *   absenteeismPct  = round(absentEmployees / rostered * 100).
 * A day nobody was rostered on is omitted, not reported as 0%.
 *
 * @param {{tenantId:string|null, month?:string}} args
 * @returns {Promise<{month:string, days:Array<{date:string,weekLabel:string,absenteeismPct:number}>}>}
 */
export async function getAbsenteeismTrend({ tenantId, month }) {
  const { start, end, label } = resolveMonth(month);
  const weeks = monthWeeks(start, end);

  // HR-RECON-02 — absenteeism against who was ROSTERED, not against everyone.
  //
  // This emitted only Mon-Sat and divided by the whole headcount. Both are
  // wrong here: Sunday is a working day for the night-shift population, so
  // their absences were never plotted; and counting people who were on their
  // weekly off in the denominator dilutes the rate, because they were never
  // due in.
  let rows = await prisma.attendance.findMany({
    where: scopedWhere(tenantId, {
      // HR-ATT-ELIG-01 — eligible employees only (see getTimesheetKpis).
      employeeId: { in: (await eligibilityEmployeeIds(tenantId, start)).eligible },
      date: { gte: start, lte: end },
    }),
    select: { employeeId: true, date: true, status: true },
  });
  // TIMESHEET-ELIG-02 — span-cap before trend aggregation.
  rows = filterRowsByEmploymentSpan(
    rows,
    (await eligibilityEmployeeIds(tenantId, start)).employmentEndByEmployee,
  );

  // Per day: who was rostered, and who of them was absent.
  const rosteredByDay = new Map();
  const absentByDay = new Map();
  for (const r of rows) {
    if (NON_WORKING_STATUSES.includes(r.status)) continue;
    const key = startOfDay(r.date).toISOString().slice(0, 10);
    if (!rosteredByDay.has(key)) rosteredByDay.set(key, new Set());
    rosteredByDay.get(key).add(r.employeeId);
    if (r.status === "ABSENT") {
      if (!absentByDay.has(key)) absentByDay.set(key, new Set());
      absentByDay.get(key).add(r.employeeId);
    }
  }

  const days = [];
  const cur = startOfDay(start);
  const last = startOfDay(end);
  while (cur.getTime() <= last.getTime()) {
    const key = cur.toISOString().slice(0, 10);
    const rostered = rosteredByDay.get(key)?.size ?? 0;
    // A day nobody was rostered on is not 0% absenteeism — it is not a data
    // point. Plotting it as zero draws a perfect day nobody worked.
    if (rostered > 0) {
      const absentEmployees = absentByDay.get(key)?.size ?? 0;
      days.push({
        date: key,
        weekLabel: weekLabelFor(cur, weeks),
        absenteeismPct: Math.round((absentEmployees / rostered) * 100),
      });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return { month: label, days };
}

// ── Check-in/out table ──────────────────────────────────────────────────────

// Map STORED enum status → FE display token.
const STATUS_DISPLAY = {
  PRESENT: "on-time",
  LATE: "late",
  HALF_DAY: "half-day",
  ABSENT: "absent",
  // HR-FE-TIMESHEET-TABLE-01 — map the non-attendance statuses too so the FE
  // receives one consistent token spelling (it filters weekly-off/holiday rows
  // and previously received the raw enum verbatim).
  WEEKLY_OFF: "weekly-off",
  HOLIDAY: "holiday",
  ON_LEAVE: "on-leave",
  MISSING_CHECKIN: "missing-checkin",
  MISSING_CHECKOUT: "missing-checkout",
};

// Map a caller-supplied status filter (display OR enum, case-insensitive) →
// the enum stored on Attendance. Returns null when unrecognized.
// UI-FIX-2026-09-14 — the FULL token set: the server-side table (operator ask:
// "column search, sort and pagination must be server side controlled") can now
// filter any status the UI can name, not just the four attendance verdicts.
function toEnumStatus(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  switch (s) {
    case "on-time":
    case "present":
      return "PRESENT";
    case "late":
      return "LATE";
    case "half-day":
      return "HALF_DAY";
    case "absent":
      return "ABSENT";
    case "missing-checkin":
      return "MISSING_CHECKIN";
    case "missing-checkout":
      return "MISSING_CHECKOUT";
    case "on-leave":
      return "ON_LEAVE";
    case "weekly-off":
      return "WEEKLY_OFF";
    case "holiday":
      return "HOLIDAY";
    default:
      return null;
  }
}

const EMPLOYEE_SELECT = {
  id: true,
  employee_name: true,
  first_name: true,
  last_name: true,
  photo_url: true,
};

function fullName(emp) {
  if (!emp) return null;
  const denorm = emp.employee_name && emp.employee_name.trim();
  if (denorm) return denorm;
  const joined = `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim();
  return joined || null;
}

/**
 * Paginated / filtered / sorted check-in/out table.
 *
 * @param {object} args
 * @param {string|null} args.tenantId
 * @param {string} [args.q]          employee-name contains, case-insensitive (JS filter)
 * @param {string} [args.status]     display or enum: on-time/present | late | half-day | absent |
 *                                   missing-checkin | missing-checkout | on-leave | weekly-off | holiday
 * @param {string} [args.exclude]    comma list of display tokens to exclude; the shorthand
 *                                   "nonworking" excludes weekly-off | holiday | on-leave. UI-FIX-2026-09-14:
 *                                   the FE hides non-working rows CLIENT-side today, which desyncs the page
 *                                   count from what is visible — exclusion is the server's job so total/page
 *                                   always describe exactly what the user sees.
 * @param {string} [args.from]       date-range start (Attendance.date)
 * @param {string} [args.to]         date-range end (Attendance.date)
 * @param {string} [args.employeeId] exact employeeId
 * @param {'date'|'employee'|'status'|'checkIn'} [args.sortBy='date']
 * @param {'asc'|'desc'} [args.sortDir='desc']
 * @param {number} [args.page=1]
 * @param {number} [args.pageSize=20]
 * @returns {Promise<{items:object[],total:number,page:number,pageSize:number}>}
 */
export async function listCheckInOuts({
  tenantId,
  q,
  status,
  exclude,
  from,
  to,
  employeeId,
  sortBy = "date",
  sortDir = "desc",
  page = 1,
  pageSize = 20,
}) {
  const where = {};
  let spanEnds = null; // TIMESHEET-ELIG-02 span caps (tenant-wide path only)

  // COLUMN-FILTERS-02 — an explicit `status` token is a positive match
  // (status = ENUM). When `exclude` is also present, the two COMBINE by
  // removing excluded statuses from the match set rather than fighting over
  // the `status` field. The old merge was inverted: it wrote
  // { not: MATCH, notIn: EXCLUDED }, which EXCLUDED the status the user
  // asked for — the Status column filter and column search silently returned
  // everything BUT the chosen status (e.g. "late" showed On-Time rows).
  // Prisma needs `NOT: { status: { in: [...] } }` for "match enum, minus
  // excluded set"; plain `notIn` alongside the positive `equals` is an
  // unsatisfiable contradiction on a single field.
  const enumStatus = toEnumStatus(status);
  if (enumStatus) where.status = enumStatus;

  // UI-FIX-2026-09-14 — server-side exclusion (see JSDoc). Applied so
  // pagination totals describe the visible set, not a superset.
  if (exclude != null && String(exclude).trim() !== "") {
    const tokens = String(exclude)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const expanded = tokens.flatMap((t) =>
      t.toLowerCase() === "nonworking"
        ? ["WEEKLY_OFF", "HOLIDAY", "ON_LEAVE"]
        : [toEnumStatus(t)].filter(Boolean),
    );
    if (expanded.length) {
      if (enumStatus) {
        // Positive match minus exclusions: NOT (status IN excluded).
        where.NOT = { status: { in: expanded.filter((s) => s !== enumStatus) } };
      } else {
        where.status = { notIn: expanded };
      }
    }
  }

  // [HR-TIMESHEET-WINDOW-01] This used to apply a date filter ONLY when from/to
  // parsed, so a missing or blank window (a cleared date picker sends `from: ""`,
  // and parseDate("") is null) meant ALL TIME — while hr_timesheet_kpis, on the
  // same screen and the same nominal filter, defaulted to the current calendar
  // month. The table then showed the newest rows in the database beside KPI
  // tiles reading zero for the current month, and the two looked like they
  // disagreed about whether the filter was applied. Same default in both now.
  //
  // It also bounds the query: every matching row is fetched and paginated in JS
  // below, so "all time" meant loading the whole attendance table per call.
  const period = resolvePeriod(from, to);
  where.date = { gte: period.from, lte: period.to };

  if (employeeId != null && String(employeeId).trim() !== "") {
    const asNum = Number(employeeId);
    where.employeeId = Number.isFinite(asNum) && String(asNum) === String(employeeId).trim() ? asNum : employeeId;
  } else {
    // HR-ATT-ELIG-01 + TIMESHEET-ELIG-02 — an explicit employeeId lookup (a
    // profile drill-down) must always work even for a separated employee's
    // history; the tenant-wide table shows eligible employees only, SPAN-CAPPED
    // per day: Obaid's Sep 1–8 rows stay, any post-termination row never shows.
    const { eligible, employmentEndByEmployee } = await eligibilityEmployeeIds(tenantId, period.from);
    where.employeeId = { in: eligible };
    spanEnds = employmentEndByEmployee;
  }

  let records = await prisma.attendance.findMany({
    where: scopedWhere(tenantId, where),
    include: { employee: { select: EMPLOYEE_SELECT } },
  });
  // TIMESHEET-ELIG-02 — enforce the employment span per row before pagination.
  records = filterRowsByEmploymentSpan(records, spanEnds);

  // TS-REQUEST-01 (operator item 9, 2026-09-17) — the Request column shows the
  // anomaly-request LIFECYCLE per row: Un-submitted (an anomaly-status day with
  // no form), Pending / Approved / Disapproved (form raised, decided or not).
  // Actual punch times stay untouched — this column is ABOUT the request, it
  // never re-grades the day. One batched fetch per window keeps the table at
  // the same query count; rows carry the full form snapshot so the
  // "View anomaly request" modal renders without a second round-trip.
  const ANOMALY_DAY_STATUSES = new Set([
    "LATE", "EARLY_CHECKOUT", "MISSING_CHECKIN", "MISSING_CHECKOUT", "HALF_DAY", "ABSENT",
  ]);
  const dayKey = (d) => startOfDay(d).toISOString().slice(0, 10);
  const rowEmployees = [...new Set(records.map((a) => a.employeeId).filter(Number.isFinite))];
  let anomaliesForWindow = [];
  if (rowEmployees.length) {
    anomaliesForWindow = await prisma.attendanceAnomaly.findMany({
      where: scopedWhere(tenantId, {
        employeeId: { in: rowEmployees },
        date: { gte: period.from, lte: period.to },
      }),
      select: {
        id: true, employeeId: true, date: true, type: true, status: true,
        sourceKind: true,
        reason: true, detail: true, fromTime: true, toTime: true,
        createdAt: true, decidedAt: true, reviewNote: true, requestDeadline: true,
        expectedTime: true, actualTime: true, positionSnapshot: true,
        departmentSnapshot: true, applicationDate: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }
  const anomalyByKey = new Map();
  for (const an of anomaliesForWindow) {
    if (an.date == null) continue; // window-wide forms don't attach to a day
    const key = `${an.employeeId}:${dayKey(an.date)}`;
    // TS-REQUEST-04 — an employee form (REGULARIZATION) outranks the
    // evaluator's grading row of the same day; among equals the newest wins
    // (the list is ordered newest-first). The row builder then only treats
    // REGULARIZATION rows as "requests".
    const existing = anomalyByKey.get(key);
    if (!existing) {
      anomalyByKey.set(key, an);
      continue;
    }
    const existingIsForm = String(existing.sourceKind ?? "").toUpperCase() === "REGULARIZATION";
    const isForm = String(an.sourceKind ?? "").toUpperCase() === "REGULARIZATION";
    if (isForm && !existingIsForm) anomalyByKey.set(key, an);
  }
  const approvalRows = anomalyByKey.size
    ? await prisma.attendanceAnomalyApproval.findMany({
        where: { anomalyId: { in: [...anomalyByKey.values()].map((a) => a.id) } },
        select: { anomalyId: true, level: true, approverRole: true, decision: true, comments: true, decidedAt: true },
        orderBy: [{ anomalyId: "asc" }, { level: "asc" }],
      })
    : [];
  const decisionsByAnomaly = new Map();
  for (const d of approvalRows) {
    if (!decisionsByAnomaly.has(d.anomalyId)) decisionsByAnomaly.set(d.anomalyId, []);
    decisionsByAnomaly.get(d.anomalyId).push({
      level: d.level, approverRole: d.approverRole, decision: d.decision,
      comments: d.comments, decidedAt: d.decidedAt,
    });
  }

  // Build display rows.
  let rows = records.map((a) => {
    const emp = a.employee;
    // TS-REQUEST-01 — the row's anomaly-request lifecycle (null = nothing to
    // show: a normal present day has no Request story).
    let request = null;
    const key = Number.isFinite(a.employeeId) ? `${a.employeeId}:${dayKey(a.date)}` : null;
    const an = key ? anomalyByKey.get(key) : null;
    // TS-REQUEST-04 (2026-09-22) — only an EMPLOYEE-SUBMITTED form is a
    // "request" for the Request column. The evaluator also stamps machine
    // grading rows (LATE/MISSING_*) into this table with its own sourceKind;
    // those carry no form. A machine-only day therefore falls through to the
    // UNSUBMITTED branch below — the FE renders it as the grey "No Request"
    // chip with NO "View anomaly request" action — while a real REGULARIZATION
    // form renders Pending/Approved/Disapproved and IS viewable. The map is
    // ordered newest-first with forms outranking grading rows, so an employee
    // CAN still answer a machine-flagged day.
    const anForm = an != null && String(an.sourceKind ?? "").toUpperCase() === "REGULARIZATION" ? an : null;
    if (anForm) {
      request = {
        anomalyId: an.id,
        status: an.status, // PENDING | APPROVED | REJECTED
        type: an.type,
        submittedAt: an.createdAt,
        decidedAt: an.decidedAt,
        reason: an.reason,
        detail: an.detail,
        fromTime: an.fromTime,
        toTime: an.toTime,
        expectedTime: an.expectedTime,
        actualTime: an.actualTime,
        requestDeadline: an.requestDeadline,
        applicationDate: an.applicationDate,
        position: an.positionSnapshot,
        department: an.departmentSnapshot,
        reviewNote: an.reviewNote,
        decisions: decisionsByAnomaly.get(an.id) ?? [],
      };
    } else if (ANOMALY_DAY_STATUSES.has(a.status)) {
      request = { status: "UNSUBMITTED" };
    }
    return {
      attendanceId: a.id,
      date: a.date,
      employee: emp
        ? { id: emp.id, name: fullName(emp), avatar: emp.photo_url ?? null }
        : { id: null, name: null, avatar: null },
      status: STATUS_DISPLAY[a.status] ?? a.status,
      checkIn: a.check_in ?? null,
      checkOut: a.check_out ?? null,
      workMode: a.work_mode ?? null,
      request,
      // internal sort keys (not serialized to the FE)
      _checkIn: a.check_in ? a.check_in.getTime() : null,
      _checkOut: a.check_out ? a.check_out.getTime() : null,
    };
  });

  // q = employee-name contains, case-insensitive (JS filter after fetch).
  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    rows = rows.filter((r) => (r.employee?.name ?? "").toLowerCase().includes(needle));
  }

  const total = rows.length;

  // ── Sort ──────────────────────────────────────────────────────────────────
  const dir = sortDir === "asc" ? 1 : -1; // default date desc
  const cmp = (a, b) => {
    let av;
    let bv;
    switch (sortBy) {
      case "employee":
        av = (a.employee?.name ?? "").toLowerCase();
        bv = (b.employee?.name ?? "").toLowerCase();
        break;
      case "status":
        av = a.status;
        bv = b.status;
        break;
      case "checkIn":
      case "checkOut": {
        // nulls sort last regardless of direction. _checkOut added with
        // UI-FIX-2 (2026-09-14): the header was sortable in the FE but the
        // whitelist here lacked it, so zod rejected the call — sort appeared
        // broken for that column.
        const aKey = sortBy === "checkIn" ? a._checkIn : a._checkOut;
        const bKey = sortBy === "checkIn" ? b._checkIn : b._checkOut;
        if (aKey == null && bKey == null) return 0;
        if (aKey == null) return 1;
        if (bKey == null) return -1;
        av = aKey;
        bv = bKey;
        break;
      }
      case "date":
      default:
        av = a.date instanceof Date ? a.date.getTime() : new Date(a.date).getTime();
        bv = b.date instanceof Date ? b.date.getTime() : new Date(b.date).getTime();
        break;
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  };
  rows.sort(cmp);

  // ── Paginate ──────────────────────────────────────────────────────────────
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safeSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.min(Math.floor(pageSize), 100) : 20;
  const start = (safePage - 1) * safeSize;
  const items = rows.slice(start, start + safeSize).map(({ _checkIn, _checkOut, ...rest }) => rest);

  logger.debug(
    { tenantId, total, page: safePage, pageSize: safeSize, sortBy, sortDir, from: period.from, to: period.to },
    "listCheckInOuts served"
  );

  // [HR-TIMESHEET-WINDOW-01] Echo the window that was actually applied, same
  // shape hr_timesheet_kpis already returns. A caller can now show it, or assert
  // the two tools agree, instead of inferring the filter from the rows.
  return {
    items,
    total,
    page: safePage,
    pageSize: safeSize,
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
  };
}

// Test seam — the eligibility core is internal by design (single source of
// truth across KPIs, graphs and table), but its span rules are exactly what
// must be unit-tested (TIMESHEET-ELIG-02).
export const __test = { eligibilityEmployeeIds, filterRowsByEmploymentSpan };

// src/services/timesheetReport.service.js
//
// HR → Timesheet read screen backend: KPI cards, two graphs, and the
// check-in/out table.
//
// AUTHORITY: every read uses the STORED Attendance.status (enum
// StatusAttendance: PRESENT | ABSENT | LATE | HALF_DAY) and STORED
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
// work_mode values that count as remote/WFH.
const REMOTE_MODES = ["Remote", "Hybrid"];

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
function resolvePeriod(from, to) {
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

// Working day = Mon–Sat (UTC getDay 1..6); Sunday (0) is a non-working day.
function isWorkingDay(d) {
  const dow = d.getUTCDay();
  return dow >= 1 && dow <= 6;
}

// Count Mon–Sat working days in [start,end] inclusive (both day-aligned).
function countWorkingDays(start, end) {
  let count = 0;
  const cur = startOfDay(start);
  const last = startOfDay(end);
  while (cur.getTime() <= last.getTime()) {
    if (isWorkingDay(cur)) count += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

// Split a calendar month into successive Week 1..N chunks. Each week runs from
// its first day up to the following Sunday (inclusive) so a "week" is a
// Mon–Sun calendar week clipped to the month bounds. The first chunk starts on
// day 1 of the month regardless of weekday.
function monthWeeks(monthStart, monthEnd) {
  const weeks = [];
  let cursor = startOfDay(monthStart);
  const last = startOfDay(monthEnd);
  let idx = 1;
  while (cursor.getTime() <= last.getTime()) {
    // End of this week = the coming Sunday (getUTCDay 0), clipped to month end.
    const weekEnd = new Date(cursor);
    // days until Sunday: (7 - dow) % 7, where Sunday(0) -> 0.
    const dow = weekEnd.getUTCDay();
    const daysToSunday = (7 - dow) % 7;
    weekEnd.setUTCDate(weekEnd.getUTCDate() + daysToSunday);
    const clippedEnd = weekEnd.getTime() > last.getTime() ? new Date(last) : weekEnd;
    weeks.push({
      label: `Week ${idx}`,
      from: startOfDay(cursor),
      to: endOfDay(clippedEnd),
    });
    // Next week starts the day after this week's (clipped) end.
    cursor = startOfDay(clippedEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    idx += 1;
  }
  return weeks;
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
export async function getTimesheetKpis({ tenantId, from, to }) {
  const period = resolvePeriod(from, to);

  const [totalEmployees, rows] = await Promise.all([
    prisma.employee.count({ where: scopedEmployeeWhere(tenantId, {}) }),
    prisma.attendance.findMany({
      where: scopedWhere(tenantId, { date: { gte: period.from, lte: period.to } }),
      select: { employeeId: true, status: true, work_mode: true },
    }),
  ]);

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

  return {
    present: presentEmp.size,
    lateArrivals,
    wfhRemote: wfhEmp.size,
    absentees: absentEmp.size,
    totalEmployees,
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
 *   expectedDays = totalEmployees * (Mon–Sat working days in that week).
 *   attendancePct = round(presentDays / expectedDays * 100), 0 on divide-by-zero.
 *
 * @param {{tenantId:string|null, month?:string}} args
 * @returns {Promise<{month:string, weeks:Array<{label:string,from:string,to:string,attendancePct:number}>}>}
 */
export async function getAttendanceSummaryWeekly({ tenantId, month }) {
  const { start, end, label } = resolveMonth(month);
  const weeks = monthWeeks(start, end);

  const [totalEmployees, rows] = await Promise.all([
    prisma.employee.count({ where: scopedEmployeeWhere(tenantId, {}) }),
    prisma.attendance.findMany({
      where: scopedWhere(tenantId, {
        date: { gte: start, lte: end },
        status: { in: PRESENT_STATUSES },
      }),
      select: { date: true },
    }),
  ]);

  const out = weeks.map((w) => {
    const presentDays = rows.filter(
      (r) => r.date.getTime() >= w.from.getTime() && r.date.getTime() <= w.to.getTime()
    ).length;
    const workingDays = countWorkingDays(w.from, w.to);
    const expectedDays = totalEmployees * workingDays;
    const attendancePct = expectedDays > 0 ? Math.round((presentDays / expectedDays) * 100) : 0;
    return {
      label: w.label,
      from: w.from.toISOString(),
      to: w.to.toISOString(),
      attendancePct,
    };
  });

  return { month: label, weeks: out };
}

// ── GRAPH 2: day-wise absenteeism trend ─────────────────────────────────────

/**
 * Day-wise absenteeism percentage for the month (default current month),
 * tagged by week label.
 *
 * We emit EVERY Mon–Sat working day of the month (Sundays are SKIPPED — they
 * are non-working days with no expected attendance, so an absenteeism % would
 * be meaningless). Per day:
 *   absentEmployees = DISTINCT employeeIds with status ABSENT on that date.
 *   absenteeismPct  = round(absentEmployees / totalEmployees * 100), 0 when
 *                     totalEmployees is 0.
 *
 * @param {{tenantId:string|null, month?:string}} args
 * @returns {Promise<{month:string, days:Array<{date:string,weekLabel:string,absenteeismPct:number}>}>}
 */
export async function getAbsenteeismTrend({ tenantId, month }) {
  const { start, end, label } = resolveMonth(month);
  const weeks = monthWeeks(start, end);

  const [totalEmployees, rows] = await Promise.all([
    prisma.employee.count({ where: scopedEmployeeWhere(tenantId, {}) }),
    prisma.attendance.findMany({
      where: scopedWhere(tenantId, {
        date: { gte: start, lte: end },
        status: "ABSENT",
      }),
      select: { employeeId: true, date: true },
    }),
  ]);

  // Bucket distinct absent employees per YYYY-MM-DD.
  const absentByDay = new Map();
  for (const r of rows) {
    const key = startOfDay(r.date).toISOString().slice(0, 10);
    if (!absentByDay.has(key)) absentByDay.set(key, new Set());
    absentByDay.get(key).add(r.employeeId);
  }

  const days = [];
  const cur = startOfDay(start);
  const last = startOfDay(end);
  while (cur.getTime() <= last.getTime()) {
    if (isWorkingDay(cur)) {
      const key = cur.toISOString().slice(0, 10);
      const absentEmployees = absentByDay.has(key) ? absentByDay.get(key).size : 0;
      const absenteeismPct = totalEmployees > 0 ? Math.round((absentEmployees / totalEmployees) * 100) : 0;
      days.push({ date: key, weekLabel: weekLabelFor(cur, weeks), absenteeismPct });
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
};

// Map a caller-supplied status filter (display OR enum, case-insensitive) →
// the enum stored on Attendance. Returns null when unrecognized.
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
 * @param {string} [args.status]     display or enum: on-time/present | late | half-day | absent
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
  from,
  to,
  employeeId,
  sortBy = "date",
  sortDir = "desc",
  page = 1,
  pageSize = 20,
}) {
  const where = {};

  const enumStatus = toEnumStatus(status);
  if (enumStatus) where.status = enumStatus;

  const parsedFrom = parseDate(from);
  const parsedTo = parseDate(to);
  if (parsedFrom || parsedTo) {
    where.date = {};
    if (parsedFrom) where.date.gte = startOfDay(parsedFrom);
    if (parsedTo) where.date.lte = endOfDay(parsedTo);
  }

  if (employeeId != null && String(employeeId).trim() !== "") {
    const asNum = Number(employeeId);
    where.employeeId = Number.isFinite(asNum) && String(asNum) === String(employeeId).trim() ? asNum : employeeId;
  }

  const records = await prisma.attendance.findMany({
    where: scopedWhere(tenantId, where),
    include: { employee: { select: EMPLOYEE_SELECT } },
  });

  // Build display rows.
  let rows = records.map((a) => {
    const emp = a.employee;
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
      // internal sort key (not serialized to the FE)
      _checkIn: a.check_in ? a.check_in.getTime() : null,
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
        // nulls sort last regardless of direction.
        if (a._checkIn == null && b._checkIn == null) return 0;
        if (a._checkIn == null) return 1;
        if (b._checkIn == null) return -1;
        av = a._checkIn;
        bv = b._checkIn;
        break;
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
  const items = rows.slice(start, start + safeSize).map(({ _checkIn, ...rest }) => rest);

  logger.debug(
    { tenantId, total, page: safePage, pageSize: safeSize, sortBy, sortDir },
    "listCheckInOuts served"
  );

  return { items, total, page: safePage, pageSize: safeSize };
}

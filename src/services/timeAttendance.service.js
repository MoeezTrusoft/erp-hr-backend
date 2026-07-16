// src/services/timeAttendance.service.js — Time & Attendance DASHBOARD read
// surface (summary KPIs, paginated records, export, pending approvals).
// Tenant-scoped. Attendance + LeaveRequest are FORCE-RLS (the singleton prisma
// sets app.tenant_id from the mcpCtx tenant automatically — see rlsTenant.js),
// so those tables are queried WITHOUT an explicit tenant predicate. Timesheet
// (tenantId, camel) and Employee (tenant_id, snake) are NOT RLS-backed, so they
// are scoped explicitly via scopedWhere / scopedEmployeeWhere.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import { parseListQuery, buildListPayload } from "../utils/apiContract.js";
import { exportRows } from "../lib/export.util.js";

const STANDARD_DAY_HOURS = 8; // fallback target/day when no WorkSchedule exists
const ABSENTEEISM_WINDOW_DAYS = 14;

const employeeName = (e) =>
  e?.employee_name || [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() || null;

// WFH derivation: an employee is "working from home" when they are PRESENT/LATE
// AND their Employee.work_mode is Remote or Hybrid (case-insensitive).
const isRemoteMode = (mode) => {
  const m = String(mode || "").toLowerCase();
  return m === "remote" || m === "hybrid";
};

// An Employee is "active" when employement_status or status reads "active"
// (the codebase writes both "Active" and "active"). Case-insensitive.
const activeEmployeeWhere = (tenantId) =>
  scopedEmployeeWhere(tenantId, {
    OR: [
      { employement_status: { equals: "active", mode: "insensitive" } },
      { status: { equals: "active", mode: "insensitive" } },
    ],
  });

// --- date helpers (UTC day bounds; date strings are YYYY-MM-DD) -------------
const dayStart = (d) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};
const dayEnd = (d) => {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
};
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const todayIso = () => new Date().toISOString().slice(0, 10);

// Target hours/day from the employee's active WorkSchedule
// (total_hours_per_week / 5) else the standard 8h day.
const targetHoursFor = (schedule) => {
  const perWeek = schedule?.total_hours_per_week;
  if (typeof perWeek === "number" && perWeek > 0) {
    return Math.round((perWeek / 5) * 100) / 100;
  }
  return STANDARD_DAY_HOURS;
};

const overtimeHours = (worked) =>
  typeof worked === "number" ? Math.max(0, Math.round((worked - STANDARD_DAY_HOURS) * 100) / 100) : 0;

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

// Load the most-recent effective WorkSchedule per employeeId (tenant-scoped)
// into a Map for O(1) target-hours lookup.
const loadScheduleMap = async (employeeIds, tenantId) => {
  const map = new Map();
  if (!employeeIds.length) return map;
  const schedules = await prisma.workSchedule.findMany({
    where: scopedWhere(tenantId, { employeeId: { in: employeeIds } }),
    orderBy: { effective_start_date: "desc" },
    select: { employeeId: true, total_hours_per_week: true },
  });
  for (const s of schedules) {
    if (!map.has(s.employeeId)) map.set(s.employeeId, s); // first = most recent
  }
  return map;
};

// Count employeeIds that are on an APPROVED leave overlapping the given day.
// LeaveRequest is FORCE-RLS → no explicit tenant predicate.
const approvedLeaveEmployeeIds = async (date) => {
  const rows = await prisma.leaveRequest.findMany({
    where: {
      status: "APPROVED",
      startDate: { lte: dayEnd(date) },
      endDate: { gte: dayStart(date) },
    },
    select: { employeeId: true },
  });
  return new Set(rows.map((r) => r.employeeId));
};

/**
 * hr_attendance_dashboard_get — summary KPIs over the tenant for the window.
 * A window may be a single `date` (default today) or a `from`/`to` range; the
 * headline counts are computed for the window's END day (or the single date),
 * while absenteeismTrend spans the last ~14 days ending on that day.
 */
export const getAttendanceDashboard = async ({ date, from, to } = {}, tenantId) => {
  const anchor = to || date || todayIso();
  const windowStart = from ? dayStart(from) : dayStart(anchor);
  const windowEnd = dayEnd(anchor);

  // Attendance rows across the window (RLS-scoped). We derive the headline day
  // counts from the anchor day and pull work_mode for WFH.
  const attendance = await prisma.attendance.findMany({
    where: { date: { gte: dayStart(anchor), lte: windowEnd } },
    include: { employee: { select: { work_mode: true } } },
  });

  const present = attendance.filter((a) => a.status === "PRESENT" || a.status === "LATE");
  const onTime = attendance.filter((a) => a.status === "PRESENT");
  const late = attendance.filter((a) => a.status === "LATE");
  const absent = attendance.filter((a) => a.status === "ABSENT");
  const wfh = present.filter((a) => isRemoteMode(a.employee?.work_mode));

  const marked = attendance.length; // employees with a record on the day
  const workforce = await prisma.employee.count({ where: activeEmployeeWhere(tenantId) });

  const leaveIds = await approvedLeaveEmployeeIds(anchor);
  const leave = leaveIds.size;
  // Unplanned = absent WITHOUT an approved leave for that day.
  const unplanned = absent.filter((a) => !leaveIds.has(a.employeeId)).length;

  // absenteeismTrend over the last ~14 days ending on the anchor.
  const trendStart = dayStart(anchor);
  trendStart.setUTCDate(trendStart.getUTCDate() - (ABSENTEEISM_WINDOW_DAYS - 1));
  const trendRows = await prisma.attendance.findMany({
    where: { date: { gte: trendStart, lte: windowEnd } },
    select: { date: true, status: true },
  });
  const byDay = new Map();
  for (const r of trendRows) {
    const key = isoDay(r.date);
    const bucket = byDay.get(key) || { total: 0, absent: 0 };
    bucket.total += 1;
    if (r.status === "ABSENT") bucket.absent += 1;
    byDay.set(key, bucket);
  }
  const absenteeismTrend = [];
  for (let i = 0; i < ABSENTEEISM_WINDOW_DAYS; i += 1) {
    const d = new Date(trendStart);
    d.setUTCDate(trendStart.getUTCDate() + i);
    const key = isoDay(d);
    const bucket = byDay.get(key) || { total: 0, absent: 0 };
    absenteeismTrend.push({ date: key, absentPct: pct(bucket.absent, bucket.total) });
  }

  return {
    date: anchor,
    from: from || null,
    to: to || null,
    present: present.length,
    onTimeArrivalPct: pct(onTime.length, marked),
    lateArrivalPct: pct(late.length, marked),
    wfh: wfh.length,
    workforce,
    workforcePct: pct(present.length, workforce),
    absent: absent.length,
    leave,
    unplanned,
    attendanceSummaryPct: pct(present.length, marked),
    absenteeismTrend,
  };
};

// --- records dashboard -------------------------------------------------------
const RECORD_SORTS = { date: "date", status: "status", workedHours: "total_hours" };

const buildRecordsWhere = (query, q) => {
  const status = query.status || null;
  const department = query.department || null;
  const from = query.from || null;
  const to = query.to || null;

  const dateFilter = {};
  if (from) dateFilter.gte = dayStart(from);
  if (to) dateFilter.lte = dayEnd(to);

  const employeeFilters = [];
  if (q) {
    employeeFilters.push({
      OR: [
        { employee_name: { contains: q, mode: "insensitive" } },
        { first_name: { contains: q, mode: "insensitive" } },
        { last_name: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (department) {
    employeeFilters.push({
      businessUnit: { is: { name: { equals: department, mode: "insensitive" } } },
    });
  }

  return {
    where: {
      // Attendance is FORCE-RLS → tenant handled by the singleton; no predicate.
      AND: [
        status ? { status } : {},
        from || to ? { date: dateFilter } : {},
        employeeFilters.length ? { employee: { is: { AND: employeeFilters } } } : {},
      ],
    },
    filters: { status, department, from, to },
  };
};

// Pending flag: any pending Timesheet (DRAFT/SUBMITTED) for the employee on the
// record's day, OR an attendance correction hint in remarks.
const REMARK_PENDING_RE = /pending|correction|awaiting|review/i;

export const listAttendanceRecords = async (query, tenantId) => {
  const list = parseListQuery(query, { sort: "date" });
  const { where, filters } = buildRecordsWhere(query, list.q);
  const orderKey = RECORD_SORTS[list.sort] || "date";
  const orderBy = { [orderKey]: list.order };

  const [rows, total] = await Promise.all([
    prisma.attendance.findMany({
      where,
      orderBy,
      skip: list.skip,
      take: list.pageSize,
      include: {
        employee: {
          select: { id: true, employee_name: true, first_name: true, last_name: true },
        },
      },
    }),
    prisma.attendance.count({ where }),
  ]);

  const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
  const scheduleMap = await loadScheduleMap(employeeIds, tenantId);

  // Pending timesheets for these employees (Timesheet is NOT RLS → scope it).
  const pendingTimesheets = employeeIds.length
    ? await prisma.timesheet.findMany({
        where: scopedWhere(tenantId, {
          employeeId: { in: employeeIds },
          status: { in: ["DRAFT", "SUBMITTED"] },
        }),
        select: { employeeId: true },
      })
    : [];
  const pendingByEmployee = new Set(pendingTimesheets.map((t) => t.employeeId));

  const items = rows.map((r) => {
    const worked = typeof r.total_hours === "number" ? r.total_hours : null;
    const requestPending =
      pendingByEmployee.has(r.employeeId) || REMARK_PENDING_RE.test(String(r.remarks || ""));
    return {
      id: r.id,
      date: isoDay(r.date),
      employeeId: r.employeeId,
      employee: employeeName(r.employee),
      status: r.status,
      checkIn: r.check_in,
      checkOut: r.check_out,
      workedHours: worked,
      overtimeHours: overtimeHours(worked),
      requestPending,
      targetHours: targetHoursFor(scheduleMap.get(r.employeeId)),
    };
  });

  return buildListPayload({ ...list, total, filters, items });
};

// --- export ------------------------------------------------------------------
const EXPORT_COLUMNS = [
  { key: "date", header: "Date" },
  { key: "employee", header: "Employee" },
  { key: "status", header: "Status" },
  { key: "checkIn", header: "Check-in", value: (r) => (r.checkIn ? new Date(r.checkIn).toISOString() : "") },
  { key: "checkOut", header: "Check-out", value: (r) => (r.checkOut ? new Date(r.checkOut).toISOString() : "") },
  { key: "workedHours", header: "Worked Hrs" },
  { key: "overtimeHours", header: "Overtime Hrs" },
  { key: "targetHours", header: "Target Hrs" },
];

export const exportAttendanceRecords = async ({ format, ...query }, tenantId) => {
  // Reuse the records shape but pull the full (capped) result set for export.
  const listQuery = { ...query, page: 1, pageSize: 5000 };
  const payload = await listAttendanceRecords(listQuery, tenantId);
  const items = payload.items;

  const { mimeType, ext, buffer } = await exportRows(format, {
    title: "Time & Attendance",
    subtitle: `${items.length} record(s) — generated ${todayIso()}`,
    columns: EXPORT_COLUMNS,
    rows: items,
  });

  return {
    format,
    fileName: `attendance-${todayIso()}.${ext}`,
    mimeType,
    count: items.length,
    base64: buffer.toString("base64"),
  };
};

// --- pending approvals -------------------------------------------------------
/**
 * hr_attendance_pending_approvals — best-effort list of items awaiting an
 * approver, sourced from SUBMITTED Timesheets (tenant-scoped; not RLS).
 */
export const listPendingApprovals = async (query, tenantId) => {
  const list = parseListQuery(query, { sort: "submitted_at" });

  const where = scopedWhere(tenantId, { status: "SUBMITTED" });
  const [rows, total] = await Promise.all([
    prisma.timesheet.findMany({
      where,
      orderBy: { submitted_at: list.order },
      skip: list.skip,
      take: list.pageSize,
      include: {
        employee: { select: { employee_name: true, first_name: true, last_name: true } },
      },
    }),
    prisma.timesheet.count({ where }),
  ]);

  const items = rows.map((t) => ({
    id: t.id,
    employee: employeeName(t.employee),
    requestName: "Timesheet approval",
    date: (t.submitted_at || t.period_end || t.created_at)?.toISOString?.().slice(0, 10) ?? null,
    timeHours: t.total_hours,
    reason: `Period ${isoDay(t.period_start)} → ${isoDay(t.period_end)}`,
  }));

  return buildListPayload({ ...list, total, filters: { status: "SUBMITTED" }, items });
};

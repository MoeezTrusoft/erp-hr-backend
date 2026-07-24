// src/services/overtimeShiftReport.service.js — read-model for the HR
// "Overtime & Shift Management" screen.
//
// Screen-shaped READ aggregations over the existing OvertimeRequest /
// ShiftTemplate / ShiftAssignment / ShiftSwapRequest tables. No writes: the FE
// reuses the existing action tools for request/withdraw/decide OT, shift
// template CRUD and shift-swap create/decide.
//
// ⚠️ NONE of OvertimeRequest / ShiftAssignment / ShiftSwapRequest declare a
// Prisma `employee` relation (they only carry Int fk columns and String? clock
// fields), so employees are BATCH-LOADED via prisma.employee.findMany({ where:
// scopedEmployeeWhere(tenantId, { id: { in: [...] } }) }) and joined in memory.
//
// Tenant scoping: scopedWhere(tenantId, …) for the C.2 tables (camelCase
// tenantId), scopedEmployeeWhere(tenantId, …) for the snake_case Employee.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";

// ── OT monthly limit (configurable) ──────────────────────────────────────────
// Per-employee approved-OT ceiling for the current calendar month. Override via
// HR_OT_MONTHLY_LIMIT; defaults to 24h.
const OT_MONTHLY_LIMIT_HOURS = Number(process.env.HR_OT_MONTHLY_LIMIT || 24);
// "Approaching / at-risk": an employee whose APPROVED OT hours this month is at
// or above 75% of the monthly limit (documented threshold).
const AT_RISK_THRESHOLD_RATIO = 0.75;
const atRiskFloor = () => OT_MONTHLY_LIMIT_HOURS * AT_RISK_THRESHOLD_RATIO;

const OT_STATUSES = new Set(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]);

const EMPLOYEE_SELECT = {
  id: true,
  employee_name: true,
  first_name: true,
  last_name: true,
  photo_url: true,
  job_title: true,
  businessUnitId: true,
};

const employeeName = (e) =>
  e?.employee_name ||
  [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() ||
  null;

// A compact employee card {id,name,avatar[,role]}. role included when withRole.
const employeeCard = (e, withRole = false) => {
  if (!e) return null;
  const card = { id: e.id, name: employeeName(e), avatar: e.photo_url ?? null };
  if (withRole) card.role = e.job_title ?? null;
  return card;
};

// Batch-load employees by id (tenant-scoped) → Map<id, employeeRow>.
const loadEmployees = async (tenantId, ids) => {
  const uniq = [...new Set(ids.filter((v) => v != null))];
  if (!uniq.length) return new Map();
  const rows = await prisma.employee.findMany({
    where: scopedEmployeeWhere(tenantId, { id: { in: uniq } }),
    select: EMPLOYEE_SELECT,
  });
  return new Map(rows.map((e) => [e.id, e]));
};

const toInt = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const clampPage = (page, pageSize, dPage = 1, dSize = 20) => {
  const p = Number(page) > 0 ? Math.trunc(Number(page)) : dPage;
  const s = Number(pageSize) > 0 ? Math.trunc(Number(pageSize)) : dSize;
  return { page: p, pageSize: s, skip: (p - 1) * s, take: s };
};

// First/last instant of a calendar month (UTC).
const monthRange = (now = new Date()) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
};

const ymKey = (dt) =>
  `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;

// Midnight-UTC of the Monday that starts the week containing `date`.
const mondayOf = (date) => {
  const dt = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const dow = dt.getUTCDay(); // 0 Sun .. 6 Sat
  const back = dow === 0 ? 6 : dow - 1; // days back to Monday
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt;
};

const addDays = (dt, n) => {
  const c = new Date(dt.getTime());
  c.setUTCDate(c.getUTCDate() + n);
  return c;
};

const isoDay = (dt) =>
  `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;

// Case/whitespace-insensitive substring match helper for in-memory q filters.
const matchesQ = (name, q) =>
  !q || (name ?? "").toLowerCase().includes(String(q).toLowerCase());

/**
 * Overtime table — one row per OvertimeRequest with its employee joined.
 * Filters: q (employee name), status, employeeId, from/to (date window).
 * Sort: date (default) | status | hours. Paginated.
 */
export const getOvertimeTable = async (
  { tenantId, q, status, employeeId, from, to, sortBy, sortDir, page, pageSize } = {}
) => {
  const empId = toInt(employeeId);
  const { page: p, pageSize: ps, skip, take } = clampPage(page, pageSize);

  const statusFilter =
    status && OT_STATUSES.has(String(status).toUpperCase())
      ? String(status).toUpperCase()
      : undefined;

  const dateWhere = {};
  if (from) {
    const f = new Date(from);
    if (!Number.isNaN(f.getTime())) dateWhere.gte = f;
  }
  if (to) {
    const t = new Date(to);
    if (!Number.isNaN(t.getTime())) dateWhere.lte = t;
  }

  const where = scopedWhere(tenantId, {
    ...(empId != null ? { employeeId: empId } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(Object.keys(dateWhere).length ? { date: dateWhere } : {}),
  });

  const dir = String(sortDir || "").toLowerCase() === "asc" ? "asc" : "desc";
  const sortField =
    sortBy === "status" ? "status" : sortBy === "hours" ? "hours" : "date";
  const orderBy = [{ [sortField]: dir }];

  // With a `q` (employee-name) filter we cannot page in the DB (the employee
  // lives in another table), so fetch all matching OT rows, join, filter by
  // name, then paginate in memory. Without `q`, page in the DB directly.
  if (q) {
    const rows = await prisma.overtimeRequest.findMany({ where, orderBy });
    const empMap = await loadEmployees(tenantId, rows.map((r) => r.employeeId));
    const joined = rows
      .map((r) => ({ r, emp: empMap.get(r.employeeId) }))
      .filter(({ emp }) => matchesQ(employeeName(emp), q));
    const total = joined.length;
    const items = joined.slice(skip, skip + take).map(({ r, emp }) => ({
      overtimeId: r.id,
      employee: employeeCard(emp),
      date: r.date,
      fromTime: r.fromTime ?? null,
      toTime: r.toTime ?? null,
      totalHours: r.hours,
      reason: r.reason ?? null,
      status: r.status,
    }));
    return { items, total, page: p, pageSize: ps };
  }

  const [rows, total] = await Promise.all([
    prisma.overtimeRequest.findMany({ where, orderBy, skip, take }),
    prisma.overtimeRequest.count({ where }),
  ]);
  const empMap = await loadEmployees(tenantId, rows.map((r) => r.employeeId));
  const items = rows.map((r) => ({
    overtimeId: r.id,
    employee: employeeCard(empMap.get(r.employeeId)),
    date: r.date,
    fromTime: r.fromTime ?? null,
    toTime: r.toTime ?? null,
    totalHours: r.hours,
    reason: r.reason ?? null,
    status: r.status,
  }));
  return { items, total, page: p, pageSize: ps };
};

/**
 * OT trend over the last 6 calendar months (incl. current). Sums
 * OvertimeRequest.hours + row counts by month + status.
 */
export const getOvertimeTrend6mo = async ({ tenantId } = {}) => {
  const now = new Date();
  // Window start = first day of the month 5 months back.
  const windowStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)
  );
  const windowEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );

  // Seed the six month buckets in order (oldest → current).
  const buckets = new Map();
  for (let i = 5; i >= 0; i -= 1) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    buckets.set(ymKey(m), {
      month: ymKey(m),
      approvedHours: 0,
      pendingHours: 0,
      rejectedHours: 0,
      approvedCount: 0,
      pendingCount: 0,
      rejectedCount: 0,
    });
  }

  const rows = await prisma.overtimeRequest.findMany({
    where: scopedWhere(tenantId, { date: { gte: windowStart, lt: windowEnd } }),
    select: { date: true, hours: true, status: true },
  });

  for (const r of rows) {
    const b = buckets.get(ymKey(new Date(r.date)));
    if (!b) continue;
    const hrs = Number(r.hours) || 0;
    if (r.status === "APPROVED") {
      b.approvedHours += hrs;
      b.approvedCount += 1;
    } else if (r.status === "PENDING") {
      b.pendingHours += hrs;
      b.pendingCount += 1;
    } else if (r.status === "REJECTED") {
      b.rejectedHours += hrs;
      b.rejectedCount += 1;
    }
    // WITHDRAWN is intentionally excluded from the trend chart.
  }

  return { months: [...buckets.values()] };
};

// Sum APPROVED OT hours per employee for the current month → Map<empId, hours>.
const approvedOtByEmployeeThisMonth = async (tenantId) => {
  const { start, end } = monthRange();
  const rows = await prisma.overtimeRequest.findMany({
    where: scopedWhere(tenantId, {
      status: "APPROVED",
      date: { gte: start, lt: end },
    }),
    select: { employeeId: true, hours: true },
  });
  const byEmp = new Map();
  for (const r of rows) {
    byEmp.set(r.employeeId, (byEmp.get(r.employeeId) || 0) + (Number(r.hours) || 0));
  }
  return byEmp;
};

/**
 * KPI tiles for the screen header.
 */
export const getShiftKpis = async ({ tenantId } = {}) => {
  const { start, end } = monthRange();
  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const todayEnd = addDays(todayStart, 1);

  const [onShiftNow, totalEmployees, pendingOvertime, approvedAgg, approvedByEmp] =
    await Promise.all([
      prisma.shiftAssignment.count({
        where: scopedWhere(tenantId, {
          status: "on_shift",
          date: { gte: todayStart, lt: todayEnd },
        }),
      }),
      prisma.employee.count({ where: scopedEmployeeWhere(tenantId, {}) }),
      prisma.overtimeRequest.count({
        where: scopedWhere(tenantId, { status: "PENDING" }),
      }),
      prisma.overtimeRequest.aggregate({
        _sum: { hours: true },
        where: scopedWhere(tenantId, {
          status: "APPROVED",
          date: { gte: start, lt: end },
        }),
      }),
      approvedOtByEmployeeThisMonth(tenantId),
    ]);

  const floor = atRiskFloor();
  let approachingLimit = 0;
  for (const hours of approvedByEmp.values()) {
    if (hours >= floor) approachingLimit += 1;
  }

  return {
    onShiftNow,
    totalEmployees,
    pendingOvertime,
    totalOvertimeThisMonth: approvedAgg._sum.hours ?? 0,
    approachingLimit,
  };
};

/**
 * Weekly roster for a department (Employee.businessUnitId == departmentId).
 * Rows: each employee with their per-day shift (off/holiday/weekend → "off")
 * and summed overtimeHours for the week. Supports q + pagination on employees.
 */
export const getDeptRosterWeek = async (
  { tenantId, departmentId, weekStart, q, page, pageSize } = {}
) => {
  const deptId = toInt(departmentId);
  if (deptId == null) {
    throw Object.assign(new Error("departmentId is required"), { status: 400 });
  }

  const monday =
    weekStart && !Number.isNaN(new Date(weekStart).getTime())
      ? mondayOf(new Date(weekStart))
      : mondayOf(new Date());
  const weekEnd = addDays(monday, 7);
  const days = Array.from({ length: 7 }, (_, i) => isoDay(addDays(monday, i)));

  const { page: p, pageSize: ps, skip, take } = clampPage(page, pageSize);

  // Department employees (tenant-scoped by snake_case tenant_id).
  const empWhere = scopedEmployeeWhere(tenantId, { businessUnitId: deptId });
  let employees = await prisma.employee.findMany({
    where: empWhere,
    select: EMPLOYEE_SELECT,
    orderBy: { id: "asc" },
  });
  if (q) {
    employees = employees.filter((e) => matchesQ(employeeName(e), q));
  }
  const totalEmployees = employees.length;
  const pageEmployees = employees.slice(skip, skip + take);
  const empIds = pageEmployees.map((e) => e.id);

  // Assignments for those employees within the week.
  const assignments = empIds.length
    ? await prisma.shiftAssignment.findMany({
        where: scopedWhere(tenantId, {
          employeeId: { in: empIds },
          date: { gte: monday, lt: weekEnd },
        }),
      })
    : [];

  // Index assignments by employee → day.
  const byEmpDay = new Map(); // empId -> Map<isoDay, assignment>
  const otByEmp = new Map();
  for (const a of assignments) {
    const key = isoDay(new Date(a.date));
    if (!byEmpDay.has(a.employeeId)) byEmpDay.set(a.employeeId, new Map());
    byEmpDay.get(a.employeeId).set(key, a);
    otByEmp.set(
      a.employeeId,
      (otByEmp.get(a.employeeId) || 0) + (Number(a.overtimeHours) || 0)
    );
  }

  const OFF_STATUSES = new Set(["off", "on_leave", "holiday"]);
  const rows = pageEmployees.map((e) => {
    const dayMap = byEmpDay.get(e.id) || new Map();
    const shifts = days.map((day) => {
      const a = dayMap.get(day);
      if (!a || OFF_STATUSES.has(a.status)) {
        return { date: day, shiftType: "off", fromTime: null, toTime: null };
      }
      return {
        date: day,
        shiftType: a.shiftType,
        fromTime: a.fromTime ?? null,
        toTime: a.toTime ?? null,
      };
    });
    return {
      employee: employeeCard(e, true),
      shifts,
      overtimeHours: otByEmp.get(e.id) || 0,
    };
  });

  return {
    department: { id: deptId },
    totalEmployees,
    days,
    rows,
    page: p,
    pageSize: ps,
  };
};

/**
 * Employees at/over 75% of the monthly OT limit (approved OT this month),
 * sorted desc by hours. Employees are batch-loaded and joined.
 */
export const getAtRiskEmployees = async ({ tenantId } = {}) => {
  const byEmp = await approvedOtByEmployeeThisMonth(tenantId);
  const floor = atRiskFloor();
  const atRisk = [...byEmp.entries()].filter(([, hours]) => hours >= floor);
  if (!atRisk.length) return [];

  const empMap = await loadEmployees(tenantId, atRisk.map(([id]) => id));
  return atRisk
    .map(([id, hours]) => ({
      employee: employeeCard(empMap.get(id), true),
      currentOvertimeHours: hours,
      limit: OT_MONTHLY_LIMIT_HOURS,
    }))
    .sort((a, b) => b.currentOvertimeHours - a.currentOvertimeHours);
};

/**
 * Shift templates + how many ShiftAssignment rows reference each (assignedCount).
 */
export const listShiftTemplatesWithCount = async (
  { tenantId, q, page, pageSize } = {}
) => {
  const { page: p, pageSize: ps, skip, take } = clampPage(page, pageSize);
  const where = scopedWhere(tenantId, {
    ...(q ? { name: { contains: String(q), mode: "insensitive" } } : {}),
  });

  const [templates, total] = await Promise.all([
    prisma.shiftTemplate.findMany({
      where,
      orderBy: { id: "asc" },
      skip,
      take,
    }),
    prisma.shiftTemplate.count({ where }),
  ]);

  const ids = templates.map((t) => t.id);
  const counts = ids.length
    ? await prisma.shiftAssignment.groupBy({
        by: ["templateId"],
        where: scopedWhere(tenantId, { templateId: { in: ids } }),
        _count: { _all: true },
      })
    : [];
  const countMap = new Map(counts.map((c) => [c.templateId, c._count._all]));

  const items = templates.map((t) => ({
    id: t.id,
    name: t.name,
    timeRange: { from: t.fromTime, to: t.toTime },
    shiftType: t.shiftType,
    workMode: t.workMode ?? null,
    assignedCount: countMap.get(t.id) || 0,
  }));

  return { items, total, page: p, pageSize: ps };
};

/**
 * Shift-swap requests with BOTH parties (requester + target) resolved.
 * Filters: status, q (matches either party's name). Paginated.
 */
export const listSwapRequests = async (
  { tenantId, status, q, page, pageSize } = {}
) => {
  const { page: p, pageSize: ps, skip, take } = clampPage(page, pageSize);
  const statusFilter = status ? String(status).toUpperCase() : undefined;

  const where = scopedWhere(tenantId, {
    ...(statusFilter ? { status: statusFilter } : {}),
  });

  const orderBy = [{ createdAt: "desc" }];

  // q matches either party's name → resolve names first, so page in memory when
  // filtering by q; otherwise page in the DB.
  if (q) {
    const rows = await prisma.shiftSwapRequest.findMany({ where, orderBy });
    const empMap = await loadEmployees(
      tenantId,
      rows.flatMap((r) => [r.requesterId, r.targetId])
    );
    const joined = rows
      .map((r) => ({
        r,
        requester: empMap.get(r.requesterId),
        target: r.targetId != null ? empMap.get(r.targetId) : null,
      }))
      .filter(
        ({ requester, target }) =>
          matchesQ(employeeName(requester), q) || matchesQ(employeeName(target), q)
      );
    const total = joined.length;
    const items = joined
      .slice(skip, skip + take)
      .map(({ r, requester, target }) => mapSwapRow(r, requester, target));
    return { items, total, page: p, pageSize: ps };
  }

  const [rows, total] = await Promise.all([
    prisma.shiftSwapRequest.findMany({ where, orderBy, skip, take }),
    prisma.shiftSwapRequest.count({ where }),
  ]);
  const empMap = await loadEmployees(
    tenantId,
    rows.flatMap((r) => [r.requesterId, r.targetId])
  );
  const items = rows.map((r) =>
    mapSwapRow(
      r,
      empMap.get(r.requesterId),
      r.targetId != null ? empMap.get(r.targetId) : null
    )
  );
  return { items, total, page: p, pageSize: ps };
};

const mapSwapRow = (r, requester, target) => ({
  id: r.id,
  requester: employeeCard(requester),
  target: employeeCard(target),
  dates: {
    from: r.fromDate,
    to: r.toDate ?? null,
    single: r.toDate == null || +new Date(r.fromDate) === +new Date(r.toDate),
  },
  reason: r.reason ?? null,
  status: r.status,
});

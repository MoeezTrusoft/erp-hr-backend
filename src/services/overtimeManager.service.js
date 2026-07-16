// src/services/overtimeManager.service.js — Overtime & Shift MANAGER view.
//
// Backs the HR manager-facing "Overtime & Shift" screens: the team overview
// KPIs, the weekly team roster, the monthly overtime trend chart, the at-risk
// list, the pending-approvals list, and the bulk shift-assignment write.
//
// Tenant scoping is fail-closed (see src/lib/tenancy.js): the C.2 tables
// (OvertimeRequest / ShiftAssignment / OvertimeRule) carry the camelCase
// `tenantId`, scoped with scopedWhere; the Employee table carries the snake_case
// `tenant_id`, scoped with scopedEmployeeWhere. ShiftAssignment has no Prisma
// relation to Employee, so employees are resolved in a second round-trip and
// stitched by employeeId.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import { parseListQuery, buildListPayload } from "../utils/apiContract.js";

// Fallback monthly overtime limit (hours) when the tenant has no OvertimeRule.
const DEFAULT_MONTHLY_LIMIT_HOURS = 40;
// Multiplier turning a weekly OvertimeRule cap into a monthly cap.
const WEEKS_PER_MONTH = 4;

const employeeName = (e) =>
  e?.employee_name ||
  [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() ||
  null;

// yyyy-mm-dd (local) for a Date, used to key ShiftAssignment rows to a day.
const dayKey = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// First/last instant of the current calendar month (local server time).
const monthRange = (now = new Date()) => {
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return { start, end };
};

// Start (Monday 00:00) of the week containing `now` (or a supplied weekStart).
const weekStartOf = (now = new Date()) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow; // shift back to Monday
  d.setDate(d.getDate() + diff);
  return d;
};

// Resolve the tenant's monthly overtime limit (hours) from OvertimeRule.
const resolveMonthlyLimit = async (tenantId) => {
  const rule = await prisma.overtimeRule.findFirst({
    where: scopedWhere(tenantId, { is_active: true }),
    orderBy: { id: "desc" },
  });
  return rule?.max_hours_per_week != null
    ? rule.max_hours_per_week * WEEKS_PER_MONTH
    : DEFAULT_MONTHLY_LIMIT_HOURS;
};

// Fetch employees by id, tenant-scoped, returning a Map keyed by id.
const employeesById = async (ids, tenantId) => {
  const unique = [...new Set(ids.filter((v) => v != null))];
  if (!unique.length) return new Map();
  const rows = await prisma.employee.findMany({
    where: scopedEmployeeWhere(tenantId, { id: { in: unique } }),
    select: {
      id: true,
      employee_name: true,
      first_name: true,
      last_name: true,
      job_title: true,
      photo_url: true,
    },
  });
  return new Map(rows.map((e) => [e.id, e]));
};

// Employee ids belonging to a department (businessUnit.name), tenant-scoped.
// Returns null when no department filter is requested (meaning "no filter").
const departmentEmployeeIds = async (department, tenantId) => {
  if (!department) return null;
  const rows = await prisma.employee.findMany({
    where: scopedEmployeeWhere(tenantId, {
      businessUnit: { is: { name: { equals: department, mode: "insensitive" } } },
    }),
    select: { id: true },
  });
  return rows.map((r) => r.id);
};

/**
 * Manager overview KPIs: team on shift now, pending OT approvals, total approved
 * OT this month, and the count of employees at/over 90% of the monthly OT limit.
 */
export const getOvertimeManagerOverview = async (_args, tenantId) => {
  const { start, end } = monthRange();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  const [teamTotal, onShiftNow, pendingApprovals, approvedThisMonth, monthlyLimit] =
    await Promise.all([
      prisma.employee.count({ where: scopedEmployeeWhere(tenantId, {}) }),
      prisma.shiftAssignment.count({
        where: scopedWhere(tenantId, {
          status: "on_shift",
          date: { gte: todayStart, lt: todayEnd },
        }),
      }),
      prisma.overtimeRequest.count({
        where: scopedWhere(tenantId, { status: "PENDING" }),
      }),
      prisma.overtimeRequest.groupBy({
        by: ["employeeId"],
        _sum: { hours: true },
        where: scopedWhere(tenantId, {
          status: "APPROVED",
          date: { gte: start, lt: end },
        }),
      }),
      resolveMonthlyLimit(tenantId),
    ]);

  const totalOvertimeThisMonth = approvedThisMonth.reduce(
    (acc, g) => acc + (g._sum.hours ?? 0),
    0
  );
  const threshold = monthlyLimit * 0.9;
  const employeesReaching90PctLimit = approvedThisMonth.filter(
    (g) => (g._sum.hours ?? 0) >= threshold
  ).length;

  return {
    teamOnShiftNow: { count: onShiftNow, total: teamTotal },
    pendingOvertimeApprovals: pendingApprovals,
    totalOvertimeThisMonth,
    employeesReaching90PctLimit,
  };
};

/**
 * Weekly team roster (7 days from the week start). One row per employee with a
 * `days` array; days with no ShiftAssignment default to status "off".
 */
export const getShiftRosterWeek = async ({ department, weekStart } = {}, tenantId) => {
  const start = weekStart ? weekStartOf(new Date(weekStart)) : weekStartOf();
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return dayKey(d);
  });

  const deptIds = await departmentEmployeeIds(department, tenantId);
  if (deptIds != null && deptIds.length === 0) return { weekStart: dayKey(start), roster: [] };

  const assignments = await prisma.shiftAssignment.findMany({
    where: scopedWhere(tenantId, {
      date: { gte: start, lt: end },
      ...(deptIds != null ? { employeeId: { in: deptIds } } : {}),
    }),
    orderBy: { date: "asc" },
  });

  const empIds = deptIds != null ? deptIds : [...new Set(assignments.map((a) => a.employeeId))];
  const empMap = await employeesById(empIds, tenantId);

  // Index assignments by employeeId -> dayKey -> row.
  const byEmpDay = new Map();
  for (const a of assignments) {
    if (!byEmpDay.has(a.employeeId)) byEmpDay.set(a.employeeId, new Map());
    byEmpDay.get(a.employeeId).set(dayKey(a.date), a);
  }

  const roster = [...empMap.values()]
    .map((e) => {
      const dayMap = byEmpDay.get(e.id) || new Map();
      const days = dates.map((dk) => {
        const a = dayMap.get(dk);
        return a
          ? {
              date: dk,
              shiftType: a.shiftType,
              workMode: a.workMode,
              status: a.status,
              fromTime: a.fromTime ?? null,
              toTime: a.toTime ?? null,
              overtimeHours: a.overtimeHours ?? 0,
            }
          : {
              date: dk,
              shiftType: null,
              workMode: null,
              status: "off",
              fromTime: null,
              toTime: null,
              overtimeHours: 0,
            };
      });
      return {
        employeeId: e.id,
        name: employeeName(e),
        photo: e.photo_url ?? null,
        designation: e.job_title ?? null,
        days,
      };
    })
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return { weekStart: dayKey(start), roster };
};

/**
 * Monthly overtime trend over the last ~6 months for a bar chart. Per month:
 * sum of approved hours, and counts of pending/approved/rejected requests.
 */
export const getOvertimeTrend = async (_args, tenantId) => {
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1, 0, 0, 0, 0);
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    months.push({ key, start: d, end: next });
  }

  const rangeStart = months[0].start;
  const rangeEnd = months[months.length - 1].end;

  const rows = await prisma.overtimeRequest.findMany({
    where: scopedWhere(tenantId, { date: { gte: rangeStart, lt: rangeEnd } }),
    select: { date: true, hours: true, status: true },
  });

  const acc = new Map(
    months.map((m) => [
      m.key,
      { month: m.key, approvedHours: 0, pending: 0, approved: 0, rejected: 0 },
    ])
  );

  for (const r of rows) {
    const d = r.date instanceof Date ? r.date : new Date(r.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const bucket = acc.get(key);
    if (!bucket) continue;
    if (r.status === "APPROVED") {
      bucket.approvedHours += r.hours ?? 0;
      bucket.approved += 1;
    } else if (r.status === "PENDING") {
      bucket.pending += 1;
    } else if (r.status === "REJECTED") {
      bucket.rejected += 1;
    }
  }

  return months.map((m) => acc.get(m.key));
};

/**
 * Employees at risk of the monthly OT limit — those whose approved OT this month
 * is ≥ 80% of the limit. Sorted by pct desc.
 */
export const getOvertimeAtRisk = async (_args, tenantId) => {
  const { start, end } = monthRange();
  const limit = await resolveMonthlyLimit(tenantId);

  const grouped = await prisma.overtimeRequest.groupBy({
    by: ["employeeId"],
    _sum: { hours: true },
    where: scopedWhere(tenantId, {
      status: "APPROVED",
      date: { gte: start, lt: end },
    }),
  });

  const atRisk = grouped
    .map((g) => ({
      employeeId: g.employeeId,
      overtimeHours: g._sum.hours ?? 0,
      pct: limit > 0 ? Math.round(((g._sum.hours ?? 0) / limit) * 100) : 0,
    }))
    .filter((r) => r.pct >= 80);

  const empMap = await employeesById(
    atRisk.map((r) => r.employeeId),
    tenantId
  );

  return atRisk
    .map((r) => {
      const e = empMap.get(r.employeeId);
      return {
        employeeId: r.employeeId,
        name: e ? employeeName(e) : null,
        photo: e?.photo_url ?? null,
        designation: e?.job_title ?? null,
        overtimeHours: r.overtimeHours,
        limit,
        pct: r.pct,
      };
    })
    .sort((a, b) => b.pct - a.pct);
};

/**
 * Paginated list of PENDING overtime requests (manager approval queue).
 * Optional department filter (via employee businessUnit.name). Sorted by date.
 */
export const listPendingOvertimeApprovals = async (
  { page, pageSize, department } = {},
  tenantId
) => {
  const list = parseListQuery({ page, pageSize }, { sort: "date", pageSize: 20 });

  const deptIds = await departmentEmployeeIds(department, tenantId);
  if (deptIds != null && deptIds.length === 0) {
    return buildListPayload({
      ...list,
      total: 0,
      filters: { department: department ?? null },
      items: [],
    });
  }

  const where = scopedWhere(tenantId, {
    status: "PENDING",
    ...(deptIds != null ? { employeeId: { in: deptIds } } : {}),
  });

  const [rows, total] = await Promise.all([
    prisma.overtimeRequest.findMany({
      where,
      orderBy: { date: "desc" },
      skip: list.skip,
      take: list.pageSize,
    }),
    prisma.overtimeRequest.count({ where }),
  ]);

  const empMap = await employeesById(
    [...rows.map((r) => r.employeeId), ...rows.map((r) => r.approverId)],
    tenantId
  );

  const items = rows.map((r) => {
    const e = empMap.get(r.employeeId);
    const approver = r.approverId != null ? empMap.get(r.approverId) : null;
    return {
      reqId: r.id,
      employeeId: r.employeeId,
      employee: e ? employeeName(e) : null,
      photo: e?.photo_url ?? null,
      dateFrom: { date: r.date, time: r.fromTime ?? null },
      dateTo: { date: r.date, time: r.toTime ?? null },
      hours: r.hours,
      rate: `${r.rate ?? 1.5}x`,
      project: r.project ?? null,
      approver: approver ? employeeName(approver) : null,
      status: r.status,
    };
  });

  return buildListPayload({
    ...list,
    total,
    filters: { department: department ?? null },
    items,
  });
};

/**
 * Bulk-create ShiftAssignment rows, tenant-stamped. Returns the created count.
 */
export const bulkAssignShifts = async ({ assignments } = {}, tenantId) => {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw Object.assign(new Error("assignments must be a non-empty array"), {
      status: 400,
    });
  }

  const data = assignments.map((a, i) => {
    const empId = Number(a?.employeeId);
    if (!Number.isFinite(empId)) {
      throw Object.assign(
        new Error(`assignments[${i}].employeeId is required`),
        { status: 400 }
      );
    }
    const parsedDate = a?.date ? new Date(a.date) : null;
    if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
      throw Object.assign(
        new Error(`assignments[${i}].date is invalid`),
        { status: 400 }
      );
    }
    return {
      employeeId: empId,
      date: parsedDate,
      shiftType: a?.shiftType ?? "morning",
      workMode: a?.workMode ?? "onsite",
      ...(a?.fromTime != null ? { fromTime: String(a.fromTime) } : {}),
      ...(a?.toTime != null ? { toTime: String(a.toTime) } : {}),
      ...(a?.templateId != null ? { templateId: Number(a.templateId) } : {}),
      tenantId: tenantId ?? null,
    };
  });

  const result = await prisma.shiftAssignment.createMany({ data });
  return { count: result.count };
};

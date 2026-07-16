// src/services/overtimeShift.service.js — Overtime & Shift Management.
//
// Backs the HR "Overtime & Shift" screens: current shift/overtime overview,
// weekly shift schedule, overtime request history, and the create/decide
// overtime-request writes. Reads/writes are tenant-scoped via the verified
// tenant (scopedWhere for the C.2 tables OvertimeRequest/WorkSchedule/
// OvertimeRule; scopedEmployeeWhere for the snake_case Employee.tenant_id).
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";

// Mon..Sun in the order the FE renders the week.
const WEEK_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const DAY_LABEL = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

// Sensible fallbacks used when the tenant has no OvertimeRule / WorkSchedule.
const DEFAULT_MONTHLY_LIMIT_HOURS = 40;
const DEFAULT_HOURS_PER_WEEK = 40;
const DEFAULT_SCHEDULE_NAME = "Standard (Mon–Fri)";
const DEFAULT_PATTERN = {
  monday: "09:00-17:00",
  tuesday: "09:00-17:00",
  wednesday: "09:00-17:00",
  thursday: "09:00-17:00",
  friday: "09:00-17:00",
};

const employeeName = (e) =>
  e?.employee_name ||
  [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() ||
  null;

// First/last instant of the current calendar month (local server time).
const monthRange = (now = new Date()) => {
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return { start, end };
};

const toEmployeeId = (employeeId) => {
  if (employeeId === undefined || employeeId === null || employeeId === "") return null;
  const n = Number(employeeId);
  return Number.isFinite(n) ? n : null;
};

// Resolve the WorkSchedule to describe. With an employeeId → that employee's
// most-recent schedule; without → a tenant default (first schedule found).
const resolveSchedule = async (empId, tenantId) => {
  const where = scopedWhere(tenantId, empId != null ? { employeeId: empId } : {});
  return prisma.workSchedule.findFirst({
    where,
    orderBy: { effective_start_date: "desc" },
  });
};

/**
 * Overview: current shift + this-month overtime approved/pending + monthly limit.
 */
export const getOvertimeShiftOverview = async ({ employeeId } = {}, tenantId) => {
  const empId = toEmployeeId(employeeId);
  const { start, end } = monthRange();

  const [schedule, rule, approvedAgg, pendingAgg] = await Promise.all([
    resolveSchedule(empId, tenantId),
    prisma.overtimeRule.findFirst({
      where: scopedWhere(tenantId, { is_active: true }),
      orderBy: { id: "desc" },
    }),
    prisma.overtimeRequest.aggregate({
      _sum: { hours: true },
      where: scopedWhere(tenantId, {
        status: "APPROVED",
        date: { gte: start, lt: end },
        ...(empId != null ? { employeeId: empId } : {}),
      }),
    }),
    prisma.overtimeRequest.aggregate({
      _sum: { hours: true },
      where: scopedWhere(tenantId, {
        status: "PENDING",
        date: { gte: start, lt: end },
        ...(empId != null ? { employeeId: empId } : {}),
      }),
    }),
  ]);

  const monthlyLimitHours =
    rule?.max_hours_per_week != null
      ? rule.max_hours_per_week * 4
      : DEFAULT_MONTHLY_LIMIT_HOURS;

  return {
    currentShift: {
      scheduleName: schedule?.schedule_name ?? DEFAULT_SCHEDULE_NAME,
      pattern: schedule?.schedule_pattern ?? DEFAULT_PATTERN,
      hoursPerWeek: schedule?.total_hours_per_week ?? DEFAULT_HOURS_PER_WEEK,
    },
    overtimeApprovedHours: approvedAgg._sum.hours ?? 0,
    overtimePendingHours: pendingAgg._sum.hours ?? 0,
    monthlyLimitHours,
  };
};

/**
 * Weekly shift schedule (Mon..Sun) from WorkSchedule.schedule_pattern.
 * Off days are flagged. Without an employeeId, the tenant default schedule.
 */
export const getShiftScheduleWeek = async ({ employeeId } = {}, tenantId) => {
  const empId = toEmployeeId(employeeId);
  const schedule = await resolveSchedule(empId, tenantId);
  const pattern =
    schedule?.schedule_pattern && typeof schedule.schedule_pattern === "object"
      ? schedule.schedule_pattern
      : DEFAULT_PATTERN;

  const week = WEEK_DAYS.map((day) => {
    const timing = pattern?.[day];
    const isWorking = typeof timing === "string" && timing.trim() !== "";
    return {
      day: DAY_LABEL[day],
      shift: isWorking ? "Day" : "Off",
      timing: isWorking ? timing : null,
      off: !isWorking,
    };
  });

  return {
    scheduleName: schedule?.schedule_name ?? DEFAULT_SCHEDULE_NAME,
    week,
  };
};

// Resolve approverId ints → display names in one round-trip.
const buildApproverMap = async (rows, tenantId) => {
  const ids = [...new Set(rows.map((r) => r.approverId).filter((v) => v != null))];
  if (!ids.length) return new Map();
  const employees = await prisma.employee.findMany({
    where: scopedEmployeeWhere(tenantId, { id: { in: ids } }),
    select: { id: true, employee_name: true, first_name: true, last_name: true },
  });
  return new Map(employees.map((e) => [e.id, employeeName(e)]));
};

/**
 * Paginated overtime request history, tenant-scoped, sorted by date desc.
 */
export const listOvertimeHistory = async (
  { employeeId, status, page, pageSize } = {},
  tenantId
) => {
  const empId = toEmployeeId(employeeId);
  const resolvedPage = Number(page) > 0 ? Number(page) : 1;
  const resolvedPageSize = Number(pageSize) > 0 ? Number(pageSize) : 20;
  const skip = (resolvedPage - 1) * resolvedPageSize;

  const where = scopedWhere(tenantId, {
    ...(empId != null ? { employeeId: empId } : {}),
    ...(status ? { status: String(status).toUpperCase() } : {}),
  });

  const [rows, total] = await Promise.all([
    prisma.overtimeRequest.findMany({
      where,
      orderBy: { date: "desc" },
      skip,
      take: resolvedPageSize,
    }),
    prisma.overtimeRequest.count({ where }),
  ]);

  const approverMap = await buildApproverMap(rows, tenantId);

  const items = rows.map((r) => ({
    reqId: r.id,
    employeeId: r.employeeId,
    date: r.date,
    hours: r.hours,
    project: r.project ?? null,
    reason: r.reason ?? null,
    approver: r.approverId != null ? approverMap.get(r.approverId) ?? null : null,
    status: r.status,
    decidedAt: r.decidedAt ?? null,
  }));

  return { items, total, page: resolvedPage, pageSize: resolvedPageSize };
};

/**
 * Create an overtime request (status PENDING). Tenant stamped via scopedWhere's
 * create-stamp counterpart is not used here — the tenant is written directly so
 * the row is fail-closed scoped to the verified tenant.
 */
export const createOvertimeRequest = async (
  { employeeId, date, hours, project, reason } = {},
  tenantId
) => {
  const empId = toEmployeeId(employeeId);
  if (empId == null) {
    throw Object.assign(new Error("employeeId is required"), { status: 400 });
  }
  const parsedDate = date ? new Date(date) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
    throw Object.assign(new Error("Valid date is required"), { status: 400 });
  }
  const parsedHours = Number(hours);
  if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
    throw Object.assign(new Error("hours must be a positive number"), { status: 400 });
  }

  const created = await prisma.overtimeRequest.create({
    data: {
      employeeId: empId,
      date: parsedDate,
      hours: parsedHours,
      project: project ?? null,
      reason: reason ?? null,
      status: "PENDING",
      tenantId: tenantId ?? null,
    },
  });

  return {
    reqId: created.id,
    employeeId: created.employeeId,
    date: created.date,
    hours: created.hours,
    project: created.project ?? null,
    reason: created.reason ?? null,
    status: created.status,
  };
};

/**
 * Approve/reject an overtime request. Sets status + decidedAt(now) + approverId
 * (the caller's employeeId). Tenant-scoped via updateMany so a foreign-tenant id
 * cannot be decided.
 */
export const decideOvertimeRequest = async (
  { id, decision, approverEmployeeId } = {},
  tenantId
) => {
  const reqId = toEmployeeId(id);
  if (reqId == null) {
    throw Object.assign(new Error("Valid request id is required"), { status: 400 });
  }
  const normalized = String(decision || "").toLowerCase();
  const status =
    normalized === "approve"
      ? "APPROVED"
      : normalized === "reject"
      ? "REJECTED"
      : null;
  if (!status) {
    throw Object.assign(new Error("decision must be 'approve' or 'reject'"), {
      status: 400,
    });
  }

  const approverId = toEmployeeId(approverEmployeeId);

  const result = await prisma.overtimeRequest.updateMany({
    where: scopedWhere(tenantId, { id: reqId }),
    data: { status, decidedAt: new Date(), approverId },
  });

  if (result.count === 0) {
    throw Object.assign(new Error("Overtime request not found"), { status: 404 });
  }

  const updated = await prisma.overtimeRequest.findFirst({
    where: scopedWhere(tenantId, { id: reqId }),
  });

  return {
    reqId: updated.id,
    employeeId: updated.employeeId,
    status: updated.status,
    decidedAt: updated.decidedAt ?? null,
    approverId: updated.approverId ?? null,
  };
};

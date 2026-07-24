// src/services/attendanceAnomaly.service.js
//
// Attendance Anomaly (time-correction / abnormality) backend for the HR
// Timesheet + Leave & Anomaly screens. An AttendanceAnomaly is an employee-
// raised request ("I was late / forgot to check out / was absent / other")
// that an HR reviewer approves or rejects.
//
// AttendanceAnomaly is FORCE-RLS (see src/lib/rlsTenant.js) — reads fold the
// verified tenant via scopedWhere(tenantId, where). Each exported op does a
// SINGLE create/update under ambient ctx, so the RLS extension auto-wraps the
// write with the tenant GUC; no tenantTransaction is needed here.
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import logger from "../lib/logger.js";

const ANOMALY_TYPES = new Set([
  "LATE_CHECKIN",
  "MISSING_CHECKIN",
  "MISSING_CHECKOUT",
  "EARLY_CHECKOUT",
  "ABSENT",
  "OTHER",
]);

// Employee select — snake_case per the Employee model (NO firstName/lastName;
// display name is employee_name || (first_name + " " + last_name).trim()).
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

function employeeDto(emp) {
  if (!emp) return null;
  return { id: emp.id, name: fullName(emp), avatar: emp.photo_url ?? null };
}

// Defensive date/time parse: coerce a string/Date to a valid Date or null.
function toDateOrNull(raw) {
  if (raw == null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function toIntOrNull(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function rowDto(row) {
  return {
    id: row.id,
    type: row.type,
    reason: row.reason ?? null,
    detail: row.detail ?? null,
    date: row.date ?? null,
    fromTime: row.fromTime ?? null,
    toTime: row.toTime ?? null,
    status: row.status,
    employee: employeeDto(row.employee),
    createdAt: row.createdAt ?? null,
    decidedAt: row.decidedAt ?? null,
    reviewNote: row.reviewNote ?? null,
  };
}

/**
 * Raise a new attendance anomaly (status PENDING). Single create — the RLS
 * extension auto-wraps with the tenant GUC.
 */
export async function informAbnormality({
  tenantId,
  employeeId,
  type,
  reason,
  detail,
  date,
  fromTime,
  toTime,
}) {
  const empId = toIntOrNull(employeeId);
  if (empId == null) {
    throw Object.assign(new Error("employeeId is required"), { status: 400 });
  }
  if (!type || !ANOMALY_TYPES.has(type)) {
    throw Object.assign(
      new Error(
        "type must be one of LATE_CHECKIN | MISSING_CHECKIN | MISSING_CHECKOUT | EARLY_CHECKOUT | ABSENT | OTHER"
      ),
      { status: 400 }
    );
  }

  const created = await prisma.attendanceAnomaly.create({
    data: {
      employeeId: empId,
      type,
      reason: reason ?? null,
      detail: detail ?? null,
      date: toDateOrNull(date),
      fromTime: toDateOrNull(fromTime),
      toTime: toDateOrNull(toTime),
      status: "PENDING",
      createdAt: new Date(),
    },
    include: { employee: { select: EMPLOYEE_SELECT } },
  });

  logger.info(
    { anomalyId: created.id, employeeId: empId, type },
    "attendance anomaly raised"
  );
  return rowDto(created);
}

/**
 * List anomalies with filter / sort / pagination.
 * @returns {{ items: object[], total: number, page: number, pageSize: number }}
 */
export async function listAnomalies({
  tenantId,
  status,
  employeeId,
  type,
  q,
  sortBy,
  sortDir,
  page,
  pageSize,
} = {}) {
  const pageNum = Math.max(1, toIntOrNull(page) || 1);
  const size = Math.min(200, Math.max(1, toIntOrNull(pageSize) || 20));

  const and = [];
  if (status && ["PENDING", "APPROVED", "REJECTED"].includes(status)) {
    and.push({ status });
  }
  const empId = toIntOrNull(employeeId);
  if (empId != null) and.push({ employeeId: empId });
  if (type && ANOMALY_TYPES.has(type)) and.push({ type });
  if (q && String(q).trim()) {
    const needle = String(q).trim();
    and.push({
      OR: [
        { reason: { contains: needle, mode: "insensitive" } },
        { employee: { employee_name: { contains: needle, mode: "insensitive" } } },
        { employee: { first_name: { contains: needle, mode: "insensitive" } } },
        { employee: { last_name: { contains: needle, mode: "insensitive" } } },
      ],
    });
  }
  const where = scopedWhere(tenantId, and.length ? { AND: and } : {});

  const sortField = ["createdAt", "date", "status"].includes(sortBy)
    ? sortBy
    : "createdAt";
  const dir = sortDir === "asc" ? "asc" : "desc";

  const [total, rows] = await Promise.all([
    prisma.attendanceAnomaly.count({ where }),
    prisma.attendanceAnomaly.findMany({
      where,
      orderBy: { [sortField]: dir },
      skip: (pageNum - 1) * size,
      take: size,
      include: { employee: { select: EMPLOYEE_SELECT } },
    }),
  ]);

  return { items: rows.map(rowDto), total, page: pageNum, pageSize: size };
}

/**
 * Approve or reject an anomaly. Loads the row tenant-scoped first (404 if
 * missing), then updates. Single update — RLS extension auto-wraps.
 */
export async function decideAnomaly({
  tenantId,
  id,
  decision,
  reviewNote,
  reviewerId,
}) {
  const anomalyId = toIntOrNull(id);
  if (anomalyId == null) {
    throw Object.assign(new Error("id is required"), { status: 400 });
  }
  if (decision !== "approve" && decision !== "reject") {
    throw Object.assign(
      new Error("decision must be one of approve | reject"),
      { status: 400 }
    );
  }

  const existing = await prisma.attendanceAnomaly.findFirst({
    where: scopedWhere(tenantId, { id: anomalyId }),
    select: { id: true },
  });
  if (!existing) {
    throw Object.assign(new Error("Anomaly not found"), { status: 404 });
  }

  const updated = await prisma.attendanceAnomaly.update({
    where: { id: anomalyId },
    data: {
      status: decision === "approve" ? "APPROVED" : "REJECTED",
      decidedAt: new Date(),
      reviewerId: reviewerId ? Number(reviewerId) : null,
      reviewNote: reviewNote ?? null,
    },
    include: { employee: { select: EMPLOYEE_SELECT } },
  });

  logger.info(
    { anomalyId, decision, reviewerId: reviewerId ? Number(reviewerId) : null },
    "attendance anomaly decided"
  );
  return rowDto(updated);
}

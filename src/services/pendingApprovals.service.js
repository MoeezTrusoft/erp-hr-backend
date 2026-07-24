// src/services/pendingApprovals.service.js
//
// Unified "pending approvals" feed for the HR Timesheet screen. It fuses two
// PENDING request streams into one normalized, sortable list:
//   • AttendanceAnomaly (status PENDING)  → source "anomaly"
//   • OvertimeRequest    (status PENDING)  → source "overtime"
//
// NORMALIZATION — each source row is projected to a common envelope so the FE
// renders one table regardless of origin:
//   { id, source, requestType, employee:{id,name,avatar}, timestamp,
//     description, raw:{…minimal} }
//   - requestType: a human label. Anomaly → mapped from its enum `type`
//     (e.g. LATE_CHECKIN → "Time Correction (late check-in)"); overtime → "OT Request".
//   - timestamp: anomaly.createdAt; overtime.date ?? overtime.decidedAt ?? overtime.createdAt.
//   - description: reason/detail free text.
// The merged list is filtered (type / q on employee name), sorted by timestamp
// desc, then paginated. `total` is the merged FILTERED count.
//
// NOTE: OvertimeRequest has NO Prisma `employee` relation, so overtime rows
// can't `include` the employee — we batch-load employees by employeeId and
// join in memory. Both tables are FORCE-RLS; reads fold the verified tenant via
// scopedWhere(tenantId, …). decidePendingApproval does a SINGLE update per
// source (RLS auto-wrapped), or delegates to decideAnomaly.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import logger from "../lib/logger.js";
import { decideAnomaly } from "./attendanceAnomaly.service.js";

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

function toIntOrNull(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Human labels for anomaly types (used as `requestType`).
const ANOMALY_TYPE_LABEL = {
  LATE_CHECKIN: "Time Correction (late check-in)",
  MISSING_CHECKIN: "Time Correction (missing check-in)",
  MISSING_CHECKOUT: "Time Correction (missing check-out)",
  EARLY_CHECKOUT: "Time Correction (early check-out)",
  ABSENT: "Absence Request",
  OTHER: "Abnormality",
};

function anomalyLabel(type) {
  return ANOMALY_TYPE_LABEL[type] || "Abnormality";
}

/**
 * Merged pending-approvals feed.
 * @returns {{ items: object[], total: number, page: number, pageSize: number }}
 */
export async function listPendingApprovals({
  tenantId,
  type,
  q,
  page,
  pageSize,
} = {}) {
  const pageNum = Math.max(1, toIntOrNull(page) || 1);
  const size = Math.min(200, Math.max(1, toIntOrNull(pageSize) || 20));
  const wantAnomaly = !type || type === "anomaly";
  const wantOvertime = !type || type === "overtime";

  // Pull both PENDING sources (tenant-scoped). Anomaly can include employee;
  // overtime cannot (no relation), so we join employees in memory below.
  const [anomalies, overtimes] = await Promise.all([
    wantAnomaly
      ? prisma.attendanceAnomaly.findMany({
          where: scopedWhere(tenantId, { status: "PENDING" }),
          include: { employee: { select: EMPLOYEE_SELECT } },
        })
      : Promise.resolve([]),
    wantOvertime
      ? prisma.overtimeRequest.findMany({
          where: scopedWhere(tenantId, { status: "PENDING" }),
        })
      : Promise.resolve([]),
  ]);

  // Batch-load employees for overtime rows (no relation to include).
  let empById = new Map();
  if (overtimes.length) {
    const ids = [...new Set(overtimes.map((o) => o.employeeId).filter((x) => x != null))];
    if (ids.length) {
      const emps = await prisma.employee.findMany({
        where: scopedEmployeeWhere(tenantId, { id: { in: ids } }),
        select: EMPLOYEE_SELECT,
      });
      empById = new Map(emps.map((e) => [e.id, e]));
    }
  }

  const anomalyItems = anomalies.map((a) => ({
    id: a.id,
    source: "anomaly",
    requestType: anomalyLabel(a.type),
    employee: employeeDto(a.employee),
    timestamp: a.createdAt ?? null,
    description: a.reason ?? a.detail ?? null,
    raw: {
      type: a.type,
      status: a.status,
      date: a.date ?? null,
      fromTime: a.fromTime ?? null,
      toTime: a.toTime ?? null,
    },
  }));

  const overtimeItems = overtimes.map((o) => ({
    id: o.id,
    source: "overtime",
    requestType: "OT Request",
    employee: employeeDto(empById.get(o.employeeId)),
    timestamp: o.date ?? o.decidedAt ?? o.createdAt ?? null,
    description: o.reason ?? null,
    raw: {
      status: o.status,
      hours: o.hours,
      rate: o.rate,
      project: o.project ?? null,
      date: o.date ?? null,
    },
  }));

  let merged = [...anomalyItems, ...overtimeItems];

  // Optional employee-name filter (case-insensitive contains).
  if (q && String(q).trim()) {
    const needle = String(q).trim().toLowerCase();
    merged = merged.filter((m) =>
      (m.employee?.name || "").toLowerCase().includes(needle)
    );
  }

  // Sort by timestamp desc (null timestamps sink to the bottom).
  merged.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });

  const total = merged.length;
  const start = (pageNum - 1) * size;
  const items = merged.slice(start, start + size);

  return { items, total, page: pageNum, pageSize: size };
}

/**
 * Decide a pending approval, dispatching by source:
 *   • "anomaly"  → decideAnomaly(...)
 *   • "overtime" → load scoped OvertimeRequest (404 if missing) + update status.
 * `reason` is accepted but OvertimeRequest has no note column, so it is ignored.
 */
export async function decidePendingApproval({
  tenantId,
  source,
  id,
  decision,
  reason,
  reviewerId,
}) {
  if (decision !== "approve" && decision !== "reject") {
    throw Object.assign(
      new Error("decision must be one of approve | reject"),
      { status: 400 }
    );
  }

  if (source === "anomaly") {
    const updated = await decideAnomaly({
      tenantId,
      id,
      decision,
      reviewNote: reason ?? null,
      reviewerId,
    });
    return { source: "anomaly", id: updated.id, decision, ...updated };
  }

  if (source === "overtime") {
    const otId = toIntOrNull(id);
    if (otId == null) {
      throw Object.assign(new Error("id is required"), { status: 400 });
    }
    const existing = await prisma.overtimeRequest.findFirst({
      where: scopedWhere(tenantId, { id: otId }),
      select: { id: true },
    });
    if (!existing) {
      throw Object.assign(new Error("Overtime request not found"), { status: 404 });
    }
    const updated = await prisma.overtimeRequest.update({
      where: { id: otId },
      data: {
        status: decision === "approve" ? "APPROVED" : "REJECTED",
        decidedAt: new Date(),
        approverId: reviewerId ? Number(reviewerId) : null,
      },
    });
    logger.info(
      { overtimeId: otId, decision, approverId: reviewerId ? Number(reviewerId) : null },
      "overtime request decided"
    );
    return { source: "overtime", id: otId, decision, ...updated };
  }

  throw Object.assign(
    new Error("source must be one of anomaly | overtime"),
    { status: 400 }
  );
}

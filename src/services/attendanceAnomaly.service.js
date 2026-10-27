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
import { uploadAnomalyAttachments } from './anomalyManagement.service.js';
import { tenantTransaction } from "../lib/rlsTenant.js";
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import logger from "../lib/logger.js";
import { routeAnomaly, resolveApprovalChain } from "./attendanceAnomalyRouting.service.js";

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
  employee_code: true,
  job_title: true,
  Position: { select: { title: true } },      businessUnit: { select: { name: true } },
};

function fullName(emp) {
  if (!emp) return null;
  return emp.employee_code || "Employee code required";
}

function employeeDto(emp) {
  if (!emp) return null;
  return { id: emp.id, name: fullName(emp), code: emp.employee_code, avatar: null };
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
    employeeId: row.employeeId,
    sourceKind: row.sourceKind,
    approvalPolicy: row.approvalPolicy,
    workflowVersion: row.workflowVersion ?? 0,
    workflowHistory: row.workflowHistory ?? [],
    attachments: row.attachments ?? [],
    manualDeductionDays: row.manualDeductionDays ?? null,
    shiftGroupKey: row.date ? `${row.employeeId}:${new Date(row.date).toISOString().slice(0,10)}` : `anomaly:${row.id}`,
    type: row.type,
    reason: row.reason ?? null,
    detail: row.detail ?? null,
    date: row.date ?? null,
    fromTime: row.fromTime ?? null,
    toTime: row.toTime ?? null,
    status: row.status,
    employee: employeeDto(row.employee),
    // TS-ONBEHALF-01 — who filled the form (employee vs HR on behalf) and the
    // raise-time snapshots the approval card renders.
    raisedById: row.raisedById ?? null,
    raisedByName: row.raisedByName ?? null,
    position: row.positionSnapshot ?? row.employee?.Position?.title ?? row.employee?.job_title ?? null,
    department: row.departmentSnapshot ?? row.employee?.businessUnit?.name ?? null,
    currentApprovalLevel: row.currentApprovalLevel ?? null,
    // T&A-RULE-03 — the request's own time facts (rostered vs punched) shown
    // beside the check-in/check-out on the approval card and request modal.
    expectedTime: row.expectedTime ?? null,
    actualTime: row.actualTime ?? null,
    createdAt: row.createdAt ?? null,
    applicationDate: row.applicationDate ?? null,
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
  reason,
  detail,
  date,
  fromTime,
  toTime,
  raisedById,
  attachments = [],
}) {
  throw Object.assign(new Error('Use Attendance anomaly review: system-generated per-shift cases, HR missing-time entries, and Management-only decisions'), {status:410});
}

// T&A-MONTH-FILTER (operator, 2026-10-06) — the approval inbox follows the
// Timesheet's month selector, so `from`/`to` bound the request's OWN DAY ("For
// date"), NOT the day it was filed on. Filtering by createdAt instead would
// show a request raised this month for a day in August, and hide one raised in
// August for a day in September — exactly the two the reviewer must see. The
// bounds are plain YYYY-MM-DD, anchored in UTC because that is how the stored
// day stamps are written, and `to` runs to the END of its day so a single-date
// range is not off by one.
const YMD = /^\d{4}-\d{2}-\d{2}$/;
function dayRange(from, to) {
  const f = String(from ?? "").trim();
  const t = String(to ?? "").trim();
  return {
    gte: YMD.test(f) ? new Date(`${f}T00:00:00.000Z`) : null,
    lte: YMD.test(t) ? new Date(`${t}T23:59:59.999Z`) : null,
  };
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
  sourceKind,
  raised,
  q,
  from,
  to,
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
  // The approval inbox is for employee regularization forms only. Evaluator,
  // imported-history, and disapproved-leave anomalies remain payroll/table
  // evidence and must not appear as employee submissions.
  if (sourceKind && ["REGULARIZATION", "evaluator", "IMPORT", "DISAPPROVED_LEAVE"].includes(sourceKind)) {
    and.push({ sourceKind });
  }
  // OPS-2026-10-08 — `raised: true` restricts the list to requests that were
  // actually raised (by the employee, or by HR on their behalf from paper
  // forms). System-generated rows — evaluator-detected anomalies, import
  // backfill, disapproved-leave echoes — are attendance evidence, not
  // requests, and must not appear in the requests panel. NOT (…=…) keeps
  // legacy rows with a NULL sourceKind (manual HR entries) visible.
  if (raised === true) {
    and.push({ NOT: { sourceKind: "evaluator" } });
  }
  if (q && String(q).trim()) {
    const needle = String(q).trim();
    and.push({
      OR: [
        { reason: { contains: needle, mode: "insensitive" } },
        { employee: { employee_code: { contains: needle, mode: "insensitive" } } },
      ],
    });
  }
  // T&A-MONTH-FILTER — the request's own day, inclusive of the whole `to` day.
  const { gte, lte } = dayRange(from, to);
  if (gte || lte) {
    and.push({ date: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } });
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
      orderBy: [{ [sortField]: dir }, { id: dir }],
      skip: (pageNum - 1) * size,
      take: size,
      include: {
        employee: { select: EMPLOYEE_SELECT },
        // TS-CARD-01 — the decision trail for the approval-matrix timeline.
        approvals: { orderBy: { level: "asc" } },
      },
    }),
  ]);

  // TS-CARD-01 (2026-09-24) — the approval-matrix view: every configured
  // chain level with its RESOLVED approver and the timeline state for THIS
  // request (APPROVED / REJECTED / PENDING-current / SKIPPED / WAITING).
  // The chain is per-requester (level 1 is usually the employee's manager),
  // so it must be resolved per row; the approver names are batch-fetched.
  const decisionsByAnomaly = new Map();
  for (const row of rows) {
    decisionsByAnomaly.set(
      row.id,
      (row.approvals ?? []).map((d) => ({
        level: d.level,
        approverId: d.approverId,
        approverRole: d.approverRole,
        decision: d.decision,
        comments: d.comments ?? null,
        decidedAt: d.decidedAt ?? null,
      }))
    );
  }

  const chainByAnomaly = new Map();
  const chainByEmployee = new Map();
  const approverIds = new Set();

  // T&A-RULE-03 (2026-10-05) — "show check-in and check-out time with the
  // anomaly request": one batched join per page against Attendance, keyed by
  // (employeeId, date). The anomaly row itself carries no punches.
  const punchByEmpDay = new Map();
  {
    const dated = rows.filter((r) => r.date instanceof Date);
    if (dated.length) {
      const distinctDates = [...new Set(dated.map((r) => r.date.getTime()))].map((t) => new Date(t));
      const distinctEmployees = [...new Set(dated.map((r) => r.employeeId))];
      const punches = await prisma.attendance.findMany({
        where: scopedWhere(tenantId, {
          employeeId: { in: distinctEmployees },
          date: { in: distinctDates },
        }),
        select: { employeeId: true, date: true, check_in: true, check_out: true },
      });
      for (const p of punches) {
        punchByEmpDay.set(`${p.employeeId}:${p.date.getTime()}`, p);
      }
    }
  }

  for (const row of rows) {
    try {
      const key = `${row.employeeId}:${row.approvalPolicy || "STANDARD"}`;
      if (!chainByEmployee.has(key)) chainByEmployee.set(key, await resolveApprovalChain({ tenantId, employeeId: row.employeeId, approvalPolicy: row.approvalPolicy }));
      const chain = chainByEmployee.get(key);
      chainByAnomaly.set(row.id, chain);
      for (const lvl of chain) if (lvl.approverId) approverIds.add(lvl.approverId);
      for (const d of decisionsByAnomaly.get(row.id) ?? []) {
        if (d.approverId) approverIds.add(d.approverId);
      }
    } catch {
      chainByAnomaly.set(row.id, []);
    }
  }

  const nameById = new Map();
  if (approverIds.size > 0) {
    const approvers = await prisma.employee.findMany({
      where: { id: { in: [...approverIds] } },
      select: EMPLOYEE_SELECT,
    });
    for (const emp of approvers) nameById.set(emp.id, fullName(emp));
  }

  const matrixFor = (row) => {
    const chain = chainByAnomaly.get(row.id) ?? [];
    const decisions = decisionsByAnomaly.get(row.id) ?? [];
    return chain.map((lvl) => {
      const dec = decisions.find((d) => d.level === lvl.level);
      let state = "WAITING";
      if (dec) {
        state = dec.decision; // APPROVED | REJECTED
      } else if (row.status !== "PENDING") {
        // The request closed without this level deciding (e.g. a terminal HR
        // rejection at an earlier level) — it never came up for them.
        state = "CLOSED";
      } else if (!lvl.resolved) {
        state = lvl.skippable ? "SKIPPED" : "UNRESOLVED";
      } else if (row.currentApprovalLevel === lvl.level) {
        state = "PENDING";
      }
      return {
        level: lvl.level,
        role: lvl.role,
        approverId: lvl.approverId,
        approverName: lvl.approverId ? nameById.get(lvl.approverId) ?? null : null,
        resolved: lvl.resolved,
        reason: lvl.reason ?? null,
        state,
        comments: dec?.comments ?? null,
        decidedAt: dec?.decidedAt ?? null,
      };
    });
  };

  return {
    items: rows.map((row) => {
      const punch =
        row.date instanceof Date
          ? punchByEmpDay.get(`${row.employeeId}:${row.date.getTime()}`)
          : null;
      return {
        ...rowDto(row),
        chain: matrixFor(row),
        // T&A-RULE-03 — the day's punches, when the row has a date.
        checkIn: punch?.check_in ?? null,
        checkOut: punch?.check_out ?? null,
      };
    }),
    total,
    page: pageNum,
    pageSize: size,
  };
}

/**
 * Edit an existing anomaly request. Only HR may edit, and only PENDING
 * requests are editable — a decision has already been recorded.
 *
 * Editable fields: type, reason, detail, date, fromTime, toTime.
 * Non-editable: status, reviewerId, decidedAt, raisedById, snapshots.
 */
export async function updateAnomaly({
  tenantId,
  id,
  reason,
  detail,
  fromTime,
  toTime,
}) {
  throw Object.assign(new Error('Use Attendance anomaly review: system-generated per-shift cases, HR missing-time entries, and Management-only decisions'), {status:410});
}

/**
 * TS-ANOM-DELETE-01 (2026-10-07) — WITHDRAW a PENDING anomaly request.
 *
 * Who may delete (operator ruling): the EMPLOYEE the request is about, or HR
 * when HR raised it on the employee's behalf (raisedById set by the HR ops
 * path). Nobody else — a request someone else filed for me is theirs to
 * withdraw, not mine. Decided requests are immutable: an APPROVED/REJECTED
 * row is part of the payroll record and cannot be withdrawn out from under
 * a deduction. HR's general edit/delete power lives in decideAnomaly
 * (approve/reject), not here.
 *
 * Deletion also removes the request's approval-chain rows so a re-raise for
 * the same employee-day (one-OPEN-per-day invariant) is not blocked by
 * orphaned chain steps.
 *
 * Returns the deleted row's identifying fields for the UI toast/audit log.
 *
 * TS-ANOM-DELETE-01/2 (2026-10-09 operator ruling) — HR/admin may withdraw
 * ANY PENDING request. Callers that already asserted DELETE hr:attendance at
 * the edge (only the Admin and HR Manager roles hold it; RBAC data verified
 * 2026-10-09, no user-level overrides) pass requesterCanDeleteAny=true and
 * skip the subject/filer check. Callers without that edge keep the original
 * subject/filer rule.
 */
export async function deleteAnomaly({
  tenantId,
  id,
  requesterEmployeeId,
  requesterCanDeleteAny,
}) {
  throw Object.assign(new Error('Use Attendance anomaly review: system-generated per-shift cases, HR missing-time entries, and Management-only decisions'), {status:410});
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
  throw Object.assign(new Error('Use Attendance anomaly review: system-generated per-shift cases, HR missing-time entries, and Management-only decisions'), {status:410});
}

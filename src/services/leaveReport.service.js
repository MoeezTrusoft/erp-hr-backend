// src/services/leaveReport.service.js
//
// Screen-shaped backend for the LEAVE half of the "Leave & Anomaly Management"
// HR screen. This is a NEW, additive surface — it does NOT replace the existing
// leave.service.js / leaveManagement.service.js flows. It exposes exactly the
// four shapes the screen binds to: type KPIs, a filterable/sortable/paginated
// leave table, self-service request submission, and an HR approve/reject decide.
//
// KEY WORKFLOW — the leave TYPE is chosen by HR at APPROVAL, not by the employee
// at request time. A submitted request has leavePolicyId = null (no type yet);
// approving it resolves a LeavePolicy by leaveTypeCode and stamps leavePolicyId.
//
// TENANCY — LeaveRequest / LeavePolicy / LeaveRequestApproval are all FORCE-RLS
// (see src/lib/rlsTenant.js). Reads fold the verified tenant via
// scopedWhere(tenantId, where); Employee counts would use scopedEmployeeWhere
// (snake_case tenant_id) but this file never counts employees. A single
// create/update runs under ambient ctx so the RLS extension auto-wraps it with
// the tenant GUC; the multi-write decide() flow uses tenantTransaction so the
// GUC is set once for the whole interactive transaction.
import prisma from "../lib/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";

// The four canonical leave-type codes the screen recognises. Anything else
// (incl. a null/pending type) buckets into "other".
const KPI_BUCKET = {
  ANNUAL: "annual",
  SICK: "sick",
  CASUAL: "casual",
  MATERNITY: "maternity",
};

const TABLE_SORT_FIELDS = {
  submittedAt: "created_at",
  startDate: "startDate",
  status: "status",
  totalDays: "totalDays",
};

// Employee select — snake_case per the Employee model (NO firstName/lastName;
// display name is employee_name || (first_name + " " + last_name).trim()).
const EMPLOYEE_SELECT = {
  id: true,
  employee_name: true,
  first_name: true,
  last_name: true,
  photo_url: true,
};

const LEAVE_POLICY_SELECT = { id: true, name: true, leaveTypeCode: true };

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

// Default KPI/table period = the current calendar month [1st 00:00 .. next 1st).
function currentMonthRange() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from, to };
}

/**
 * WORKING-DAY RULE for totalDays: an inclusive count of Mon–Sat between start
 * and end (Sunday is the only non-working day). Both bounds are treated at UTC
 * midnight; a same-day request on a working day = 1, on a Sunday = 0. Guarded so
 * start must be <= end.
 */
function workingDaysMonToSat(start, end) {
  let count = 0;
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur.getTime() <= last.getTime()) {
    if (cur.getUTCDay() !== 0) count += 1; // 0 = Sunday
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

function sameDay(a, b) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}

/**
 * Type KPIs for the period. Counts LeaveRequest rows whose created_at (the
 * submitted timestamp) falls in [from, to), grouped by the assigned policy's
 * leaveTypeCode. Rows with no type (pending) or an unrecognised code bucket into
 * "other". total = every row in the period.
 * @returns {{annual,sick,casual,maternity,other,total,period:{from,to}}}
 */
export async function getLeaveTypeKpis({ tenantId, from, to } = {}) {
  const def = currentMonthRange();
  const gte = toDateOrNull(from) ?? def.from;
  const lt = toDateOrNull(to) ?? def.to;

  const where = scopedWhere(tenantId, { created_at: { gte, lt } });
  const rows = await prisma.leaveRequest.findMany({
    where,
    select: { id: true, leavePolicy: { select: { leaveTypeCode: true } } },
  });

  const out = { annual: 0, sick: 0, casual: 0, maternity: 0, other: 0, total: 0 };
  for (const r of rows) {
    out.total += 1;
    const code = r.leavePolicy?.leaveTypeCode ?? null;
    const bucket = code ? KPI_BUCKET[code] : null;
    if (bucket) out[bucket] += 1;
    else out.other += 1;
  }
  out.period = { from: gte, to: lt };
  return out;
}

/**
 * The main leave table — filterable, sortable, paginated. Each row is shaped for
 * the screen (see the DTO below). Type/policy come from the (optional) assigned
 * LeavePolicy; a pending request has type=null.
 * @returns {{items:object[], total:number, page:number, pageSize:number}}
 */
export async function listLeaveTable({
  tenantId,
  q,
  status,
  leaveType,
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
  if (status && ["PENDING", "APPROVED", "REJECTED", "CANCELLED"].includes(status)) {
    and.push({ status });
  }
  if (leaveType && KPI_BUCKET[leaveType]) {
    and.push({ leavePolicy: { is: { leaveTypeCode: leaveType } } });
  }
  const gte = toDateOrNull(from);
  const lt = toDateOrNull(to);
  if (gte || lt) {
    const range = {};
    if (gte) range.gte = gte;
    if (lt) range.lte = lt;
    and.push({ startDate: range });
  }
  if (q && String(q).trim()) {
    const needle = String(q).trim();
    and.push({
      employee: {
        OR: [
          { employee_name: { contains: needle, mode: "insensitive" } },
          { first_name: { contains: needle, mode: "insensitive" } },
          { last_name: { contains: needle, mode: "insensitive" } },
        ],
      },
    });
  }
  const where = scopedWhere(tenantId, and.length ? { AND: and } : {});

  const sortField = TABLE_SORT_FIELDS[sortBy] || "created_at";
  const dir = sortDir === "asc" ? "asc" : "desc";

  const [total, rows] = await Promise.all([
    prisma.leaveRequest.count({ where }),
    prisma.leaveRequest.findMany({
      where,
      orderBy: { [sortField]: dir },
      skip: (pageNum - 1) * size,
      take: size,
      include: {
        employee: { select: EMPLOYEE_SELECT },
        leavePolicy: { select: LEAVE_POLICY_SELECT },
      },
    }),
  ]);

  const items = rows.map((row) => ({
    leaveId: row.id,
    employee: employeeDto(row.employee),
    type: row.leavePolicy?.leaveTypeCode ?? null,
    policyName: row.leavePolicy?.name ?? null,
    dates: {
      from: row.startDate,
      to: row.endDate,
      single: sameDay(row.startDate, row.endDate),
    },
    submittedAt: row.created_at,
    totalDays: row.totalDays,
    status: row.status,
  }));

  return { items, total, page: pageNum, pageSize: size };
}

/**
 * Submit a leave request. NO type is chosen here — leavePolicyId is null and the
 * request is PENDING; HR assigns the type at approval. totalDays is the inclusive
 * Mon–Sat working-day count between start and end. created_at auto-stamps.
 * @returns the created LeaveRequest row
 */
export async function requestLeave({
  tenantId,
  employeeId,
  startDate,
  endDate,
  reason,
  createdById,
} = {}) {
  const empId = toIntOrNull(employeeId);
  if (empId == null) {
    throw Object.assign(new Error("employeeId is required"), { status: 400 });
  }
  const start = toDateOrNull(startDate);
  const end = toDateOrNull(endDate);
  if (!start) {
    throw Object.assign(new Error("startDate is required (ISO date)"), { status: 400 });
  }
  if (!end) {
    throw Object.assign(new Error("endDate is required (ISO date)"), { status: 400 });
  }
  if (start.getTime() > end.getTime()) {
    throw Object.assign(new Error("startDate must be on or before endDate"), { status: 400 });
  }

  const totalDays = workingDaysMonToSat(start, end);
  const author = toIntOrNull(createdById);

  const created = await prisma.leaveRequest.create({
    data: {
      employeeId: empId,
      leavePolicyId: null, // type set by HR at approval
      startDate: start,
      endDate: end,
      totalDays,
      reason: reason ?? null,
      status: "PENDING",
      createdById: author ?? empId,
    },
    include: {
      employee: { select: EMPLOYEE_SELECT },
      leavePolicy: { select: LEAVE_POLICY_SELECT },
    },
  });

  logger.info(
    { leaveRequestId: created.id, employeeId: empId, totalDays },
    "leave request submitted (pending, no type)"
  );
  return created;
}

/**
 * HR decide (approve / reject). On approve the caller MUST pass a leaveType code
 * which is resolved to the tenant's LeavePolicy by leaveTypeCode and stamped onto
 * the request; reject needs no type. Runs the load + update + approval-row insert
 * in ONE tenantTransaction so all three writes share the tenant GUC.
 * @returns the updated LeaveRequest (with leavePolicy included)
 */
export async function decideLeave({
  tenantId,
  id,
  decision,
  leaveType,
  approverId,
  comments,
} = {}) {
  const reqId = toIntOrNull(id);
  if (reqId == null) {
    throw Object.assign(new Error("id is required"), { status: 400 });
  }
  if (decision !== "approve" && decision !== "reject") {
    throw Object.assign(new Error("decision must be one of approve | reject"), { status: 400 });
  }
  if (decision === "approve" && !leaveType) {
    throw Object.assign(
      new Error("leaveType is required when approving (HR assigns the type at approval)"),
      { status: 400 }
    );
  }

  // LeaveRequestApproval.approverId / createdById are NOT NULL in the schema, so
  // a reviewer identity is required to record the decision row.
  const approver = toIntOrNull(approverId);
  if (approver == null) {
    throw Object.assign(new Error("approverId is required to record a decision"), { status: 400 });
  }

  return tenantTransaction(
    prisma,
    async (tx) => {
      const existing = await tx.leaveRequest.findFirst({
        where: scopedWhere(tenantId, { id: reqId }),
        select: { id: true },
      });
      if (!existing) {
        throw Object.assign(new Error("Leave request not found"), { status: 404 });
      }

      const data = {
        status: decision === "approve" ? "APPROVED" : "REJECTED",
        updatedById: approver,
      };

      if (decision === "approve") {
        const policy = await tx.leavePolicy.findFirst({
          where: scopedWhere(tenantId, { leaveTypeCode: leaveType }),
          select: { id: true },
        });
        if (!policy) {
          throw Object.assign(
            new Error(`No LeavePolicy found for leaveType "${leaveType}"`),
            { status: 400 }
          );
        }
        data.leavePolicyId = policy.id;
      }

      const updated = await tx.leaveRequest.update({
        where: { id: reqId },
        data,
        include: {
          employee: { select: EMPLOYEE_SELECT },
          leavePolicy: { select: LEAVE_POLICY_SELECT },
        },
      });

      await tx.leaveRequestApproval.create({
        data: {
          leaveRequestId: reqId,
          approverId: approver,
          approverRole: "HR",
          decision: decision === "approve" ? "APPROVED" : "REJECTED",
          comments: comments ?? null,
          decision_date: new Date(),
          createdById: approver,
        },
      });

      logger.info(
        { leaveRequestId: reqId, decision, leaveType: leaveType ?? null, approverId: approver },
        "leave request decided"
      );
      return updated;
    },
    { tenantId }
  );
}

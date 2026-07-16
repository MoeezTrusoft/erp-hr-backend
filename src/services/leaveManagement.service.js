// src/services/leaveManagement.service.js — Leave Management dashboard.
//
// Read/aggregate surface behind the HR Leave Management dashboard: balances
// summary (by type), a paginated requests dashboard, a unified approve/reject
// decision, next-30-day per-department coverage, and a leave-by-type report.
//
// TENANCY:
//   * LeaveRequest is FORCE-RLS (rlsTenant.js sets app.tenant_id from the
//     verified ctx tenant automatically) — its queries are tenant-scoped by the
//     DB policy, so we do NOT add a tenantId predicate to leaveRequest reads.
//   * LeaveBalance / LeavePolicy / Employee / BusinessUnit are NOT force-RLS;
//     we fold the verified tenant into every predicate via scopedWhere /
//     scopedEmployeeWhere (fail-closed).
//
// FIELD NAMES (verified against prisma/schema.prisma):
//   LeaveRequest: employeeId, leavePolicyId, startDate, endDate, totalDays,
//     status(LeaveRequestStatus PENDING|APPROVED|REJECTED|CANCELLED), reason,
//     created_at, createdById.
//   LeaveBalance: composite id [employeeId, leavePolicyId], balance,
//     carryOverBalance, lastUpdated. (No entitled/used columns — see note.)
//   LeavePolicy: name, leaveTypeCode. (No `leaveType` column — types are
//     derived from name/leaveTypeCode.)
//   LeaveRequestApproval: leaveRequestId, approverId, approverRole,
//     decision(ApprovalDecision APPROVED|REJECTED), comments, decision_date,
//     createdById.
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedEmployeeWhere } from "../lib/tenancy.js";
import { parseListQuery, buildListPayload } from "../utils/apiContract.js";

// ── type bucketing ─────────────────────────────────────────────────────────
// The 4 canonical buckets + "other". A policy is bucketed by a case-insensitive
// substring match on its leaveTypeCode first, then its name.
const TYPE_BUCKETS = ["annual", "sick", "casual", "maternity"];

const bucketForPolicy = (policy) => {
  const hay = `${policy?.leaveTypeCode || ""} ${policy?.name || ""}`.toLowerCase();
  for (const bucket of TYPE_BUCKETS) {
    if (hay.includes(bucket)) return bucket;
  }
  return "other";
};

const emptyBucket = () => ({ total: 0, remaining: 0, used: 0 });

const employeeName = (e) =>
  e?.employee_name ||
  [e?.first_name, e?.last_name].filter(Boolean).join(" ").trim() ||
  null;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

// ────────────────────────────────────────────────────────────────────────────
// 1. hr_leave_balances_summary
// ────────────────────────────────────────────────────────────────────────────
// LeaveBalance has no `entitled`/`used` columns — only `balance` (remaining) and
// `carryOverBalance`. We derive:
//   remaining = balance
//   used      = SUM(totalDays) of that employee/policy's APPROVED leave requests
//   total     = remaining + used + carryOverBalance   (entitlement reconstructed)
export const getLeaveBalancesSummary = async ({ employeeId } = {}, tenantId) => {
  const empId = employeeId != null && employeeId !== "" ? Number(employeeId) : null;

  const balances = await prisma.leaveBalance.findMany({
    where: scopedWhere(tenantId, empId != null ? { employeeId: empId } : {}),
    include: { leavePolicy: { select: { id: true, name: true, leaveTypeCode: true } } },
  });

  // Sum APPROVED leave taken per (employeeId, leavePolicyId). LeaveRequest is
  // RLS-scoped by the DB, so no tenant predicate here.
  const usedRows = await prisma.leaveRequest.groupBy({
    by: ["employeeId", "leavePolicyId"],
    where: { status: "APPROVED", ...(empId != null ? { employeeId: empId } : {}) },
    _sum: { totalDays: true },
  });
  const usedMap = new Map(
    usedRows.map((r) => [`${r.employeeId}:${r.leavePolicyId}`, r._sum.totalDays || 0])
  );

  const summary = {
    annual: emptyBucket(),
    sick: emptyBucket(),
    casual: emptyBucket(),
    maternity: emptyBucket(),
    other: emptyBucket(),
  };

  for (const b of balances) {
    const bucket = bucketForPolicy(b.leavePolicy);
    const used = usedMap.get(`${b.employeeId}:${b.leavePolicyId}`) || 0;
    const remaining = b.balance || 0;
    const carry = b.carryOverBalance || 0;
    summary[bucket].remaining += remaining;
    summary[bucket].used += used;
    summary[bucket].total += remaining + used + carry;
  }

  for (const k of Object.keys(summary)) {
    summary[k].total = round2(summary[k].total);
    summary[k].remaining = round2(summary[k].remaining);
    summary[k].used = round2(summary[k].used);
  }

  return {
    scope: empId != null ? "employee" : "tenant",
    employeeId: empId,
    balances: summary,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// 2. hr_leave_requests_dashboard
// ────────────────────────────────────────────────────────────────────────────
const DASHBOARD_SORTS = { submitted: "created_at", status: "status" };

export const getLeaveRequestsDashboard = async (query, tenantId) => {
  const list = parseListQuery(query, { sort: "submitted" });
  const status = query.status ? String(query.status).toUpperCase() : null;
  const typeFilter = query.type ? String(query.type).trim() : null;
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;

  const and = [];
  if (status) and.push({ status });
  if (typeFilter) {
    and.push({
      leavePolicy: {
        is: {
          OR: [
            { name: { contains: typeFilter, mode: "insensitive" } },
            { leaveTypeCode: { contains: typeFilter, mode: "insensitive" } },
          ],
        },
      },
    });
  }
  // Overlap filter: request [startDate,endDate] intersects [from,to].
  if (from) and.push({ endDate: { gte: from } });
  if (to) and.push({ startDate: { lte: to } });
  if (list.q) {
    and.push({
      employee: {
        is: {
          OR: [
            { employee_name: { contains: list.q, mode: "insensitive" } },
            { first_name: { contains: list.q, mode: "insensitive" } },
            { last_name: { contains: list.q, mode: "insensitive" } },
          ],
        },
      },
    });
  }

  // LeaveRequest is FORCE-RLS — tenant scoping is applied by the DB policy.
  const where = and.length ? { AND: and } : {};
  const sortField = DASHBOARD_SORTS[list.sort] || "created_at";
  const orderBy = { [sortField]: list.order };

  const [rows, total] = await Promise.all([
    prisma.leaveRequest.findMany({
      where,
      orderBy,
      skip: list.skip,
      take: list.pageSize,
      include: {
        employee: {
          select: { id: true, employee_name: true, first_name: true, last_name: true },
        },
        leavePolicy: { select: { id: true, name: true, leaveTypeCode: true } },
      },
    }),
    prisma.leaveRequest.count({ where }),
  ]);

  const items = rows.map((r) => ({
    id: r.id,
    employee: employeeName(r.employee),
    employeeId: r.employeeId,
    type: r.leavePolicy?.name ?? null,
    fromDate: r.startDate,
    toDate: r.endDate,
    submitted: r.created_at,
    days: r.totalDays,
    status: r.status,
    reason: r.reason ?? null,
  }));

  return buildListPayload({
    ...list,
    total,
    filters: { status, type: typeFilter, from: query.from ?? null, to: query.to ?? null },
    items,
  });
};

// ────────────────────────────────────────────────────────────────────────────
// 3. hr_leave_request_decide (unified approve / reject)
// ────────────────────────────────────────────────────────────────────────────
// Mirrors the existing leave.service approve/reject shape: records a
// LeaveRequestApproval row, flips the request status, and (on approve) deducts
// the leave balance. Kept self-contained so it needs no shared-file edits.
export const decideLeaveRequest = async ({ id, decision, reason }, user, tenantId) => {
  const leaveRequestId = Number(id);
  const norm = String(decision || "").toLowerCase();
  if (norm !== "approve" && norm !== "reject") {
    throw Object.assign(new Error('decision must be "approve" or "reject"'), { status: 400 });
  }
  if (norm === "reject" && !String(reason || "").trim()) {
    throw Object.assign(new Error("reason is required when rejecting"), { status: 400 });
  }

  const approverId =
    user?.employeeId != null && user.employeeId !== ""
      ? Number(user.employeeId)
      : null;
  if (approverId == null || Number.isNaN(approverId)) {
    throw Object.assign(new Error("Acting employee context is required to decide"), { status: 400 });
  }

  const request = await prisma.leaveRequest.findUnique({ where: { id: leaveRequestId } });
  if (!request) throw Object.assign(new Error("Leave request not found"), { status: 404 });
  if (request.status !== "PENDING") {
    throw Object.assign(new Error("Leave request is not pending"), { status: 409 });
  }

  const isApprove = norm === "approve";
  const newStatus = isApprove ? "APPROVED" : "REJECTED";
  const approverRole = Array.isArray(user?.roles) && user.roles.length ? String(user.roles[0]) : "APPROVER";

  const ops = [
    prisma.leaveRequestApproval.create({
      data: {
        leaveRequestId,
        approverId,
        approverRole,
        decision: newStatus,
        comments: reason ?? null,
        decision_date: new Date(),
        createdById: approverId,
        ...scopedWhere(tenantId, {}),
      },
    }),
    prisma.leaveRequest.update({
      where: { id: leaveRequestId },
      data: { status: newStatus, updatedById: approverId, ...(reason ? { reason } : {}) },
    }),
  ];

  if (isApprove) {
    // Deduct from balance (best-effort — only if a balance row exists).
    const bal = await prisma.leaveBalance.findUnique({
      where: {
        employeeId_leavePolicyId: {
          employeeId: request.employeeId,
          leavePolicyId: request.leavePolicyId,
        },
      },
    });
    if (bal) {
      ops.push(
        prisma.leaveBalance.update({
          where: {
            employeeId_leavePolicyId: {
              employeeId: request.employeeId,
              leavePolicyId: request.leavePolicyId,
            },
          },
          data: { balance: (bal.balance || 0) - (request.totalDays || 0), lastUpdated: new Date() },
        })
      );
    }
  }

  const results = await prisma.$transaction(ops);
  return { id: leaveRequestId, status: newStatus, decision: norm, updated: results[1] };
};

// ────────────────────────────────────────────────────────────────────────────
// 4. hr_leave_next30_coverage
// ────────────────────────────────────────────────────────────────────────────
export const getNext30Coverage = async (_args, tenantId) => {
  const today = startOfDay(new Date());
  const rangeStart = today;
  const rangeEnd = new Date(today.getTime() + 29 * DAY_MS); // 30-day inclusive window

  // Active employees grouped by business unit (department). Employee uses
  // snake-case tenant column → scopedEmployeeWhere.
  const employees = await prisma.employee.findMany({
    where: scopedEmployeeWhere(tenantId, {}),
    select: {
      id: true,
      businessUnitId: true,
      businessUnit: { select: { id: true, name: true } },
    },
  });

  const deptOf = new Map(); // employeeId → department name
  const deptTotals = new Map(); // department → total employees
  for (const e of employees) {
    const dept = e.businessUnit?.name || "Unassigned";
    deptOf.set(e.id, dept);
    deptTotals.set(dept, (deptTotals.get(dept) || 0) + 1);
  }

  // APPROVED requests overlapping the 30-day window. RLS-scoped.
  const approved = await prisma.leaveRequest.findMany({
    where: {
      status: "APPROVED",
      startDate: { lte: rangeEnd },
      endDate: { gte: rangeStart },
    },
    select: { employeeId: true, startDate: true, endDate: true },
  });

  // Build the daily series and per-department on-leave tallies.
  const totalEmployees = employees.length;
  const daily = [];
  const deptOnLeaveDaySum = new Map(); // department → sum over days of onLeave count

  for (let i = 0; i < 30; i++) {
    const day = new Date(rangeStart.getTime() + i * DAY_MS);
    const dayStart = startOfDay(day);
    let onLeaveCount = 0;
    const seenPerDept = new Map();

    for (const r of approved) {
      const s = startOfDay(r.startDate);
      const e = startOfDay(r.endDate);
      if (dayStart >= s && dayStart <= e) {
        onLeaveCount++;
        const dept = deptOf.get(r.employeeId) || "Unassigned";
        seenPerDept.set(dept, (seenPerDept.get(dept) || 0) + 1);
      }
    }
    for (const [dept, cnt] of seenPerDept) {
      deptOnLeaveDaySum.set(dept, (deptOnLeaveDaySum.get(dept) || 0) + cnt);
    }

    const present = totalEmployees - onLeaveCount;
    daily.push({
      date: dayStart.toISOString().slice(0, 10),
      day: WEEKDAYS[dayStart.getDay()],
      present,
      onLeave: onLeaveCount,
      presentPct: totalEmployees ? round2((present / totalEmployees) * 100) : 100,
    });
  }

  // Per-department summary: onLeave = peak concurrent on-leave across the window;
  // present/presentPct derived at that peak.
  const departments = [];
  for (const [dept, total] of deptTotals) {
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      const day = new Date(rangeStart.getTime() + i * DAY_MS);
      const dayStart = startOfDay(day);
      let cnt = 0;
      for (const r of approved) {
        if ((deptOf.get(r.employeeId) || "Unassigned") !== dept) continue;
        const s = startOfDay(r.startDate);
        const e = startOfDay(r.endDate);
        if (dayStart >= s && dayStart <= e) cnt++;
      }
      if (cnt > peak) peak = cnt;
    }
    const present = total - peak;
    departments.push({
      department: dept,
      totalEmployees: total,
      presentEmployees: present,
      onLeave: peak,
      presentPct: total ? round2((present / total) * 100) : 100,
    });
  }
  departments.sort((a, b) => a.department.localeCompare(b.department));

  return {
    range: { from: daily[0]?.date ?? null, to: daily[daily.length - 1]?.date ?? null, days: 30 },
    totalEmployees,
    departments,
    daily,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// 5. hr_leave_by_type_report
// ────────────────────────────────────────────────────────────────────────────
export const getLeaveByTypeReport = async ({ from, to } = {}) => {
  const and = [{ status: "APPROVED" }];
  if (from) and.push({ endDate: { gte: new Date(from) } });
  if (to) and.push({ startDate: { lte: new Date(to) } });

  // RLS-scoped LeaveRequest read; group by policy so we can bucket by type.
  const rows = await prisma.leaveRequest.groupBy({
    by: ["leavePolicyId"],
    where: { AND: and },
    _sum: { totalDays: true },
  });

  const policyIds = rows.map((r) => r.leavePolicyId);
  const policies = policyIds.length
    ? await prisma.leavePolicy.findMany({
        where: { id: { in: policyIds } },
        select: { id: true, name: true, leaveTypeCode: true },
      })
    : [];
  const policyMap = new Map(policies.map((p) => [p.id, p]));

  const report = { annual: 0, sick: 0, casual: 0, maternity: 0, other: 0 };
  for (const r of rows) {
    const bucket = bucketForPolicy(policyMap.get(r.leavePolicyId) || {});
    report[bucket] += r._sum.totalDays || 0;
  }
  for (const k of Object.keys(report)) report[k] = round2(report[k]);

  return {
    period: { from: from ?? null, to: to ?? null },
    byType: report,
  };
};

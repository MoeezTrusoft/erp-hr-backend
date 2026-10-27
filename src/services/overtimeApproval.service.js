import { legacyDecision } from "./approval/legacy.js";
// src/services/overtimeApproval.service.js
//
// Overtime uses the shared employee, manager, HR and Management workflow.
// Legacy payroll matrices remain readable for historical configuration only.
//
// Two ways overtime arrives:
//   * the employee punches overtime in/out on the device — ZKTeco status 4 and
//     5 are Overtime-In and Overtime-Out, and those punches are already stored;
//   * the employee raises a manual request for hours the device did not capture.
//
// Both land in the same queue and follow the same approvals, so approved
// overtime has one meaning regardless of how it was recorded.
//
// Only APPROVED overtime reaches payroll. It is written to
// shift_assignments.overtimeHours for the day, which is what payroll reads —
// pending or rejected hours never appear there.
//
// HR-OT-APPROVAL-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";

const badRequest = (m) => Object.assign(new Error(m), { status: 400 });
const notFound = (m) => Object.assign(new Error(m), { status: 404 });
const forbidden = (m) => Object.assign(new Error(m), { status: 403 });

const startOfDay = (v) => { const d = new Date(v); d.setHours(0, 0, 0, 0); return d; };

/**
 * The payroll approval chain as it applies to ONE requester.
 *
 * Deliberately the payroll matrix rather than the attendance one: overtime is
 * money, and the instruction was that it follows the same order as payroll.
 * Levels whose approver cannot be resolved, or who ARE the requester, drop out —
 * nobody approves their own overtime.
 */
export async function resolveOvertimeChain({ tenantId, employeeId }) {
  const levels = await prisma.payrollApprovalMatrix.findMany({
    where: { tenantId, status: "ACTIVE" },
    orderBy: [{ level: "asc" }, { id: "asc" }],
  });

  return levels.map((lvl) => {
    let approverId = lvl.approverId ?? null;
    let reason = approverId ? null : "no approver configured";
    if (approverId && approverId === employeeId) {
      approverId = null;
      reason = "approver is the requester";
    }
    return { level: lvl.level, role: lvl.role, approverId, resolved: Boolean(approverId), reason };
  });
}


/** Raise overtime for a day. `source` records whether the device saw it. */
export async function createOvertimeRequest({
  tenantId, employeeId, date, hours, reason, fromTime, toTime, source = "MANUAL", project,
}) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) throw badRequest("hours must be greater than 0");
  // A day cannot contain more than a day of overtime; a typo here is expensive.
  if (h > 16) throw badRequest("hours must be 16 or fewer for a single day");
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw badRequest("reason is required");

  const day = startOfDay(date);

  const existing = await prisma.overtimeRequest.findFirst({
    where: { tenantId, employeeId, date: day, status: { in: ["PENDING", "APPROVED"] } },
  });
  // One live request per employee-day, or the same hours get approved twice and
  // paid twice.
  if (existing) {
    throw badRequest(`Overtime for ${day.toISOString().slice(0, 10)} is already ${existing.status}`);
  }

  // Capture creates a candidate. Only the employee can submit it for review.

  const request = await tenantTransaction(prisma, async (tx) =>
    tx.overtimeRequest.create({
      data: {
        tenantId, employeeId, date: day, hours: h, reason: text,
        fromTime: fromTime ?? null, toTime: toTime ?? null,
        project: project ?? null, source,
        status: "PENDING",
        currentApprovalLevel: 1,
        approverId: null,
      },
    }),
  );

  return {request,routed:false,level:null,chain:[],stage:'INITIATOR',workflowUrl:'/hr/approvals'};
}

/**
 * Record one decision. REJECTED is terminal; APPROVED advances, and only the
 * final approval writes hours to payroll.
 */
export async function decideOvertimeRequest({ tenantId, requestId, approverId, decision, comments }) {
  return legacyDecision('OVERTIME',requestId);
}

/** Overtime requests waiting on this approver right now. */
export async function listOvertimeForApprover({ tenantId, approverId }) {
  const pending = await prisma.overtimeRequest.findMany({
    where: { tenantId, status: "PENDING" },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  const out = [];
  for (const r of pending) {
    const chain = await resolveOvertimeChain({ tenantId, employeeId: r.employeeId });
    const current = chain.find((c) => c.level === r.currentApprovalLevel);
    if (current?.resolved && current.approverId === approverId) {
      out.push({ ...r, level: current.level, role: current.role });
    }
  }
  return out;
}

/**
 * Raise overtime requests from OVERTIME PUNCHES already on the device.
 *
 * ZKTeco status 4 is Overtime-In and 5 is Overtime-Out; those punches are stored
 * exactly like any other, so overtime the employee actually clocked can become a
 * request without anyone re-typing it. Paired in/out only — a lone overtime
 * punch has no duration and is reported rather than guessed at.
 *
 * Defaults to a dry run: this creates payable claims.
 */
export async function detectOvertimeFromPunches({ tenantId, from, to, dryRun = true }) {
  const punches = await prisma.attendanceDevicePunch.findMany({
    where: {
      tenantId,
      employeeId: { not: null },
      status: { in: [4, 5] },
      punchedAt: { gte: new Date(`${from}T00:00:00`), lte: new Date(`${to}T23:59:59`) },
    },
    select: { employeeId: true, punchedAt: true, status: true },
    orderBy: [{ employeeId: "asc" }, { punchedAt: "asc" }],
  });

  const summary = { from, to, dryRun, overtimePunches: punches.length, created: 0, unpaired: 0, skippedExisting: 0, details: [] };

  const byEmployee = new Map();
  for (const p of punches) {
    if (!byEmployee.has(p.employeeId)) byEmployee.set(p.employeeId, []);
    byEmployee.get(p.employeeId).push(p);
  }

  for (const [employeeId, list] of byEmployee) {
    let open = null;
    for (const p of list) {
      if (p.status === 4) { open = p; continue; }
      if (p.status === 5 && open) {
        const started = open;
        open = null;
        const hours = Number(((p.punchedAt - started.punchedAt) / 3600000).toFixed(2));
        if (hours <= 0 || hours > 16) { summary.unpaired += 1; continue; }
        // Attributed to the day the overtime STARTED, so a session running past
        // midnight is not split across two days.
        const day = startOfDay(started.punchedAt);
        summary.details.push({ employeeId, date: day.toISOString().slice(0, 10), hours });
        if (!dryRun) {
          try {
            await createOvertimeRequest({
              tenantId, employeeId, date: day, hours,
              reason: "Overtime punched on the device",
              source: "DEVICE_PUNCH",
            });
            summary.created += 1;
          } catch (err) {
            if (/already/.test(err?.message || "")) summary.skippedExisting += 1;
            else throw err;
          }
        } else {
          summary.created += 1;
        }
      } else if (p.status === 5) {
        summary.unpaired += 1;   // an overtime-out with no overtime-in
      }
    }
    if (open) summary.unpaired += 1;
  }

  logger[dryRun ? "info" : "warn"](summary, dryRun ? "overtime detection (dry run)" : "overtime requests created from punches");
  return summary;
}

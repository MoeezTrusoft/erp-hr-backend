// src/services/overtimeApproval.service.js
//
// Overtime, routed through the SAME ordered chain as payroll
// (PayrollApprovalMatrix), and reflected in payroll once approved.
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

const firstActionable = (chain) => chain.find((c) => c.resolved) ?? null;

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

  const chain = await resolveOvertimeChain({ tenantId, employeeId });
  const target = firstActionable(chain);

  const request = await tenantTransaction(prisma, async (tx) =>
    tx.overtimeRequest.create({
      data: {
        tenantId, employeeId, date: day, hours: h, reason: text,
        fromTime: fromTime ?? null, toTime: toTime ?? null,
        project: project ?? null, source,
        status: "PENDING",
        currentApprovalLevel: target?.level ?? 1,
        approverId: target?.approverId ?? null,
      },
    }),
  );

  if (!target) {
    // Never auto-approve an unroutable request: that would pay hours nobody
    // agreed to. It stays PENDING and is logged loudly for a human.
    logger.error({ requestId: request.id, employeeId, chain },
      "overtime request has no resolvable approver — left PENDING");
  }

  return { request, routed: Boolean(target), level: target?.level ?? null, chain };
}

/**
 * Record one decision. REJECTED is terminal; APPROVED advances, and only the
 * final approval writes hours to payroll.
 */
export async function decideOvertimeRequest({ tenantId, requestId, approverId, decision, comments }) {
  const verdict = String(decision || "").trim().toUpperCase();
  if (!["APPROVED", "REJECTED"].includes(verdict)) {
    throw badRequest("decision must be APPROVED or REJECTED");
  }

  const request = await prisma.overtimeRequest.findUnique({ where: { id: requestId } });
  if (!request) throw notFound(`Overtime request ${requestId} not found`);
  if (request.status !== "PENDING") throw badRequest(`Request ${requestId} is already ${request.status}`);

  const chain = await resolveOvertimeChain({ tenantId, employeeId: request.employeeId });
  const current = chain.find((c) => c.level === request.currentApprovalLevel);
  if (!current) throw badRequest("Request is not pointed at a configured approval level");
  if (!current.resolved || current.approverId !== approverId) {
    throw forbidden("You are not the approver for this level");
  }

  const next = firstActionable(chain.filter((c) => c.level > current.level));
  const advances = verdict === "APPROVED" && Boolean(next);

  return tenantTransaction(prisma, async (tx) => {
    await tx.overtimeRequestApproval.create({
      data: {
        tenantId, overtimeRequestId: requestId, level: current.level,
        approverId, approverRole: current.role, decision: verdict, comments: comments ?? null,
      },
    });

    const updated = await tx.overtimeRequest.update({
      where: { id: requestId },
      data: advances
        ? { currentApprovalLevel: next.level, approverId: next.approverId }
        : { status: verdict, decidedAt: new Date(), approverId },
    });

    let payrollHours = null;
    if (!advances && verdict === "APPROVED") {
      // ONLY now does payroll see it. shift_assignments.overtimeHours is what
      // the payroll run reads, so pending or rejected hours never reach pay.
      const day = startOfDay(request.date);
      const assignment = await tx.shiftAssignment.findFirst({
        where: { employeeId: request.employeeId, date: day },
        orderBy: { id: "desc" },
      });
      if (assignment) {
        await tx.shiftAssignment.update({
          where: { id: assignment.id },
          data: { overtimeHours: request.hours, updatedAt: new Date() },
        });
      } else {
        await tx.shiftAssignment.create({
          data: {
            tenantId, employeeId: request.employeeId, date: day,
            shiftType: "morning", workMode: "onsite", status: "on_shift",
            overtimeHours: request.hours,
          },
        });
      }
      payrollHours = request.hours;
    }

    logger.info(
      { requestId, level: current.level, decision: verdict, final: !advances, payrollHours },
      "overtime decision recorded",
    );
    return { request: updated, final: !advances, nextLevel: advances ? next.level : null, payrollHours };
  });
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

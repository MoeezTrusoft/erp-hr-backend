// src/services/attendanceAnomalyRouting.service.js
//
// Routes an attendance anomaly (regularization request) through the approval
// chain configured in Payroll Setup: level 1 first, ascending.
//
// This gates money. A rejected anomaly is what feeds the DISAPPROVED_LEAVE
// deduction, and an approved one is what releases a day held by
// requires_regularization. So the two failure modes that matter are the
// silent ones:
//
//   * auto-approving because no level resolved — the chain must never be
//     treated as "satisfied" when it simply had nobody in it;
//   * letting the requester approve their own request, which is possible the
//     moment someone is their own manager or is themselves the configured HR
//     approver.
//
// Both are handled explicitly below.
//
// HR-ATT-POLICY-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}
function forbidden(message) {
  return Object.assign(new Error(message), { status: 403 });
}

/**
 * The chain as it applies to ONE requester, in order.
 *
 * Each entry reports its resolved approver, or null with a reason. Resolution is
 * per-requester because level 1 is usually dynamic (the requester's own
 * manager), so the same config yields different chains for different people.
 */
export async function resolveApprovalChain({ tenantId, employeeId }) {
  const [levels, employee] = await Promise.all([
    prisma.attendanceApprovalLevel.findMany({
      where: { tenantId, rowStatus: "ACTIVE" },
      orderBy: { level: "asc" },
    }),
    prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, managerId: true },
    }),
  ]);

  if (!employee) throw notFound(`Employee ${employeeId} not found`);

  return levels.map((lvl) => {
    let approverId = null;
    let reason = null;

    if (lvl.useEmployeeManager) {
      approverId = employee.managerId ?? null;
      if (!approverId) reason = "no manager on the employee record";
    } else {
      approverId = lvl.approverId ?? null;
      if (!approverId) reason = "no approver configured";
    }

    // Nobody may approve their own request. Without this, an employee who is
    // their own manager — or who IS the configured HR approver — silently
    // self-clears a deduction.
    if (approverId && approverId === employeeId) {
      approverId = null;
      reason = "approver is the requester";
    }

    return {
      level: lvl.level,
      role: lvl.role,
      approverId,
      resolved: Boolean(approverId),
      skippable: lvl.skipIfUnresolved,
      reason,
    };
  });
}

/** The first level that has a real approver, honouring skipIfUnresolved. */
function firstActionableLevel(chain) {
  for (const entry of chain) {
    if (entry.resolved) return entry;
    // A level that cannot resolve and is NOT skippable blocks the chain; it must
    // not be stepped over silently.
    if (!entry.skippable) return entry;
  }
  return null;
}

/**
 * Point an anomaly at its first actionable level.
 *
 * Returns { routed: false } when the chain yields nobody. The anomaly stays
 * PENDING in that case — deliberately. Auto-approving an unroutable request
 * would release a held day, and auto-rejecting it would trigger a deduction; the
 * only safe outcome is to leave it for a human and say so loudly.
 */
export async function routeAnomaly({ tenantId, anomalyId }) {
  const anomaly = await prisma.attendanceAnomaly.findUnique({ where: { id: anomalyId } });
  if (!anomaly) throw notFound(`Anomaly ${anomalyId} not found`);

  const chain = await resolveApprovalChain({ tenantId, employeeId: anomaly.employeeId });
  const target = firstActionableLevel(chain);

  if (!target || !target.resolved) {
    logger.error(
      { anomalyId, employeeId: anomaly.employeeId, chain },
      "attendance anomaly has no resolvable approver — left PENDING for manual handling",
    );
    return { routed: false, chain, reason: target?.reason ?? "no approval levels configured" };
  }

  const updated = await tenantTransaction(prisma, async (tx) =>
    tx.attendanceAnomaly.update({
      where: { id: anomalyId },
      data: { currentApprovalLevel: target.level, status: "PENDING" },
    }),
  );

  return { routed: true, level: target.level, approverId: target.approverId, anomaly: updated, chain };
}

/**
 * Record one decision and advance, or finalise.
 *
 * REJECTED is terminal at any level: one refusal ends the request, and that is
 * what a DISAPPROVED_LEAVE deduction keys off. APPROVED advances to the next
 * actionable level, and only becomes final once no level remains.
 */
export async function decideAnomaly({ tenantId, anomalyId, approverId, decision, comments }) {
  const verdict = String(decision || "").trim().toUpperCase();
  if (!["APPROVED", "REJECTED"].includes(verdict)) {
    throw badRequest("decision must be APPROVED or REJECTED");
  }

  const anomaly = await prisma.attendanceAnomaly.findUnique({ where: { id: anomalyId } });
  if (!anomaly) throw notFound(`Anomaly ${anomalyId} not found`);
  if (anomaly.status !== "PENDING") {
    throw badRequest(`Anomaly ${anomalyId} is already ${anomaly.status}`);
  }

  const chain = await resolveApprovalChain({ tenantId, employeeId: anomaly.employeeId });
  const current = chain.find((c) => c.level === anomaly.currentApprovalLevel);
  if (!current) throw badRequest("Anomaly is not pointed at a configured approval level");

  // Only the approver this level resolves to may decide it.
  if (!current.resolved || current.approverId !== approverId) {
    throw forbidden("You are not the approver for this level");
  }

  const remaining = chain.filter((c) => c.level > current.level);
  const nextTarget = firstActionableLevel(remaining);
  const advances = verdict === "APPROVED" && nextTarget?.resolved;

  return tenantTransaction(prisma, async (tx) => {
    await tx.attendanceAnomalyApproval.create({
      data: {
        tenantId,
        anomalyId,
        level: current.level,
        approverId,
        approverRole: current.role,
        decision: verdict,
        comments: comments ?? null,
      },
    });

    const data = advances
      ? { currentApprovalLevel: nextTarget.level }
      : {
          status: verdict,
          decidedAt: new Date(),
          reviewerId: approverId,
          reviewNote: comments ?? null,
        };

    const updated = await tx.attendanceAnomaly.update({ where: { id: anomalyId }, data });

    logger.info(
      { anomalyId, level: current.level, decision: verdict, final: !advances },
      "attendance anomaly decision recorded",
    );

    return { anomaly: updated, final: !advances, nextLevel: advances ? nextTarget.level : null };
  });
}

/**
 * Anomalies waiting on this approver right now.
 *
 * The chain is per-requester, so this filters in application code rather than
 * SQL: a level using useEmployeeManager matches a different approver for every
 * requester, which no single WHERE clause can express.
 */
export async function listPendingForApprover({ tenantId, approverId }) {
  const pending = await prisma.attendanceAnomaly.findMany({
    where: { tenantId, status: "PENDING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const out = [];
  for (const anomaly of pending) {
    const chain = await resolveApprovalChain({ tenantId, employeeId: anomaly.employeeId });
    const current = chain.find((c) => c.level === anomaly.currentApprovalLevel);
    if (current?.resolved && current.approverId === approverId) {
      out.push({ ...anomaly, level: current.level, role: current.role });
    }
  }
  return out;
}

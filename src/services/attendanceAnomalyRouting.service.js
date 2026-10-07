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
      select: { id: true, tenant_id: true, managerId: true },
    }),
  ]);

  if (!employee || employee.tenant_id !== tenantId) {
    throw notFound(`Employee ${employeeId} not found in this tenant`);
  }

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
  const anomaly = await prisma.attendanceAnomaly.findUnique({
    where: { id: anomalyId },
    select: { id: true, tenantId: true, employeeId: true, status: true, currentApprovalLevel: true, createdAt: true },
  });
  if (!anomaly || anomaly.tenantId !== tenantId) {
    throw notFound(`Anomaly ${anomalyId} not found in this tenant`);
  }

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
 * The tenant's configured HR approver (the attendance_approval_levels row with
 * role HR), or null. HR-DECIDE-ANY-LEVEL (operator, 2026-10-07): HR verifies
 * every anomaly for the tenant, so she may decide a request sitting at an
 * EARLIER level (her decision stands in for that level), after which the chain
 * advances normally — Management still decides last.
 */
export async function hrApproverIdFor({ tenantId }) {
  const hr = await prisma.attendanceApprovalLevel.findFirst({
    where: { tenantId, role: "HR", rowStatus: "ACTIVE", approverId: { not: null } },
    orderBy: { level: "asc" },
    select: { approverId: true },
  });
  return hr?.approverId ?? null;
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

  const anomaly = await prisma.attendanceAnomaly.findUnique({
    where: { id: anomalyId },
    select: { id: true, tenantId: true, employeeId: true, status: true, currentApprovalLevel: true },
  });
  if (!anomaly || anomaly.tenantId !== tenantId) {
    throw notFound(`Anomaly ${anomalyId} not found in this tenant`);
  }
  if (anomaly.status !== "PENDING") {
    throw badRequest(`Anomaly ${anomalyId} is already ${anomaly.status}`);
  }

  const chain = await resolveApprovalChain({ tenantId, employeeId: anomaly.employeeId });
  const current = chain.find((c) => c.level === anomaly.currentApprovalLevel);
  if (!current) throw badRequest("Anomaly is not pointed at a configured approval level");

  // Only the approver this level resolves to may decide it — EXCEPT the
  // tenant's HR approver (HR-DECIDE-ANY-LEVEL): HR verifies every anomaly for
  // the tenant, so she decides an anomaly parked at an earlier level, her
  // decision standing in for that level. The requester themselves never gains
  // this (approverId === employeeId stays forbidden at every level).
  const isHrStandIn =
    approverId !== anomaly.employeeId &&
    approverId === (await hrApproverIdFor({ tenantId }));
  if (!current.resolved || (current.approverId !== approverId && !isHrStandIn)) {
    throw forbidden("You are not the approver for this level");
  }

  const remaining = chain.filter((c) => c.level > current.level);
  // HR-DECIDE-ANY-LEVEL — an HR stand-in VERIFY covers her own HR level as
  // well (one decision, not two); the approval trail records both rows.
  const coveredHrLevel =
    isHrStandIn && verdict === "APPROVED"
      ? chain.find((c) => c.level > current.level && c.approverId === approverId) ?? null
      : null;
  const nextTarget = firstActionableLevel(
    coveredHrLevel ? remaining.filter((c) => c.level !== coveredHrLevel.level) : remaining
  );
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
    if (coveredHrLevel) {
      await tx.attendanceAnomalyApproval.create({
        data: {
          tenantId,
          anomalyId,
          level: coveredHrLevel.level,
          approverId,
          approverRole: coveredHrLevel.role,
          decision: verdict,
          comments: `HR verify standing in at level ${current.level}${comments ? ` — ${comments}` : ""}`,
        },
      });
    }

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
  const hrId = await hrApproverIdFor({ tenantId });
  for (const anomaly of pending) {
    const chain = await resolveApprovalChain({ tenantId, employeeId: anomaly.employeeId });
    const current = chain.find((c) => c.level === anomaly.currentApprovalLevel);
    if (!current) continue;
    const hers = current.resolved && current.approverId === approverId;
    // HR-DECIDE-ANY-LEVEL — the tenant's HR approver also sees requests parked
    // at a level BEFORE her own HR level (she may verify them there). A request
    // at or after her level follows the normal chain.
    const hrLevel =
      approverId === hrId
        ? chain.find((c) => c.role === "HR" && c.approverId === approverId)
        : null;
    const standIn =
      Boolean(hrLevel) && approverId !== anomaly.employeeId && current.level < hrLevel.level;
    if (hers || standIn) {
      out.push({ ...anomaly, level: current.level, role: current.role });
    }
  }
  return out;
}

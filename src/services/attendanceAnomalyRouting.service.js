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
export async function resolveApprovalChain({ tenantId, employeeId, approvalPolicy = "STANDARD" }) {
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

  const selectedLevels = approvalPolicy === "HR_MANAGEMENT" ? levels.filter(l => /^(HR|MANAGEMENT|MGMT)$/i.test(l.role)) : levels;
  if (approvalPolicy === 'HR_MANAGEMENT' && (!selectedLevels.some(l=>/^HR$/i.test(l.role)) || !selectedLevels.some(l=>/^(MANAGEMENT|MGMT)$/i.test(l.role)))) throw badRequest('HR verification and management approval must both be configured');
  const out = [];
  for (const lvl of selectedLevels) {
    let approverId = null;
    let reason = null;

    if (lvl.useEmployeeManager) {
      approverId = employee.managerId ?? null;
      if (!approverId) reason = "no manager on the employee record";
    } else {
      approverId = lvl.approverId ?? null;
      if (!approverId) reason = "no approver configured";
    }

    // HR-SELF-APPROVE-REPAIR (2026-10-07) — nobody may approve their own
    // request. When the resolved approver IS the requester, her level
    // self-resolves to the matrix's NEXT explicit approver: the workflow has
    // effectively skipped her level, so the next matrix member verifies the
    // request in her place. The requester gains nothing: the stand-in is by
    // definition a DIFFERENT configured person. The level's OTHER properties
    // (skippable) are untouched — a non-skippable level that cannot resolve
    // through this passthrough still blocks as before.
    if (approverId && approverId === employeeId) {
      approverId = null;
      reason = "approver is the requester";
      const nextExplicit = selectedLevels
        .filter((l) => l.level > lvl.level && !l.useEmployeeManager)
        .sort((a, b) => a.level - b.level)
        .find((l) => l.approverId && l.approverId !== employeeId);
      if (nextExplicit) {
        approverId = nextExplicit.approverId;
      }
    }

    out.push({
      level: lvl.level,
      role: lvl.role,
      approverId,
      resolved: Boolean(approverId),
      skippable: lvl.skipIfUnresolved,
      reason,
      ...(reason === "approver is the requester" && approverId ? { standInForRole: lvl.role } : {}),
    });
  }

  return out;
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
export async function routeAnomaly({ tenantId, anomalyId, skipLevelsBefore = 0 }) {
  const anomaly = await prisma.attendanceAnomaly.findUnique({
    where: { id: anomalyId },
    select: { id: true, tenantId: true, employeeId: true, status: true, workflowVersion: true, approvalPolicy: true, currentApprovalLevel: true, createdAt: true },
  });
  if (!anomaly || anomaly.tenantId !== tenantId) {
    throw notFound(`Anomaly ${anomalyId} not found in this tenant`);
  }

  const chain = await resolveApprovalChain({ tenantId, employeeId: anomaly.employeeId, approvalPolicy: anomaly.approvalPolicy });
  // HR-RAISED-STARTS-AT-HR (operator, 2026-10-07) — a form HR raised ON BEHALF
  // of an employee starts at HR (skipLevelsBefore=1): the manager step is for
  // the employee's own reporting line, and HR already holds the facts. The
  // employee-submitted path keeps skipLevelsBefore=0 (manager first).
  const eligible = chain.filter((c) => c.level >= (Number(skipLevelsBefore) || 0));
  const target = firstActionableLevel(eligible.length ? eligible : chain);

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
    select: { id: true, tenantId: true, employeeId: true, status: true, currentApprovalLevel: true, workflowVersion: true, approvalPolicy: true, sourceKind: true },
  });
  if (!anomaly || anomaly.tenantId !== tenantId) {
    throw notFound(`Anomaly ${anomalyId} not found in this tenant`);
  }
  if (anomaly.sourceKind && !["REGULARIZATION", "PAPER_FORM"].includes(anomaly.sourceKind)) throw badRequest("Submit a regularization request before approving a device anomaly");
  if (anomaly.status !== "PENDING") {
    throw badRequest(`Anomaly ${anomalyId} is already ${anomaly.status}`);
  }

  const chain = await resolveApprovalChain({ tenantId, employeeId: anomaly.employeeId, approvalPolicy: anomaly.approvalPolicy });
  const current = chain.find((c) => c.level === anomaly.currentApprovalLevel);
  if (!current) throw badRequest("Anomaly is not pointed at a configured approval level");

  // Only the approver this level resolves to may decide it — EXCEPT:
  //   • the tenant's HR approver (HR-DECIDE-ANY-LEVEL): HR verifies every
  //     anomaly for the tenant, so she may decide a request parked at an
  //     EARLIER level (her decision stands in for that level), after which
  //     the chain advances normally — Management still decides last.
  //   • HR-SELF-APPROVE-REPAIR: when the requested level resolved via the
  //     self-referential passthrough (resolveApprovalChain gave it the next
  //     matrix member as approverId), that member decides it legitimately —
  //     HERSELF remains excluded because the passthrough never targets the
  //     requester.
  const isHrStandIn =
    approverId !== anomaly.employeeId &&
    approverId === (await hrApproverIdFor({ tenantId })) &&
    chain.some(step => step.approverId === approverId && step.level >= current.level);
  const isMatrixStandIn = current.standInForRole != null && current.approverId === approverId;
  if (
    !current.resolved ||
    (current.approverId !== approverId && !isHrStandIn && !isMatrixStandIn)
  ) {
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

    const changed = await tx.attendanceAnomaly.updateMany({where:{id:anomalyId,tenantId,status:'PENDING',currentApprovalLevel:anomaly.currentApprovalLevel,workflowVersion:anomaly.workflowVersion},data:{...data,workflowVersion:{increment:1}}});
    if (changed.count!==1) throw Object.assign(new Error('Request changed; refresh before deciding'),{status:409});
    const updated = await tx.attendanceAnomaly.findUnique({where:{id:anomalyId}});

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
      const chain = await resolveApprovalChain({ tenantId, employeeId: anomaly.employeeId, approvalPolicy: anomaly.approvalPolicy });
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
      // HR-SELF-APPROVE-REPAIR — an anomaly parked at a level that resolved to
      // this approver via the self-approver passthrough (standInForRole set)
      // must appear in HER queue: she is the one who decides it.
      const matrixStandIn = current.standInForRole != null && current.approverId === approverId;
      if (hers || standIn || matrixStandIn) {
        out.push({ ...anomaly, level: current.level, role: current.role });
      }
    }
    return out;
  }

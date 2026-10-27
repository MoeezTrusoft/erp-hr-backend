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
//   * letting a requester give final approval to their own request. HR may
//     verify their own request only with separate management approval remaining.
//
// Both are handled explicitly below.
//
// HR-ATT-POLICY-01.
import prisma from "../lib/prisma.js";
import { loadAttendanceRuntime } from "./attendanceSetup.service.js";
import { dateKey } from "../lib/attendanceDates.js";
import { employedOn } from '../lib/attendanceDates.js';
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
export async function resolveApprovalChain({ tenantId, employeeId, approvalPolicy = "STANDARD", date = new Date() }) {
  const runtime=await loadAttendanceRuntime({tenantId,from:dateKey(date),to:dateKey(date)});
  const config=runtime.configOn(date);
  const levels=(config?.approvalLevels||[]).filter(l=>l.rowStatus==='ACTIVE');
  const employee=config?.employees?.find(e=>e.id===employeeId);


  if (!employee) {
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

    // HR verification may be performed by the requester only when a separate
    // management approver remains mandatory. Verification is not final approval.
    const selfHrVerification = approverId === employeeId && /^HR$/i.test(lvl.role)
      && selectedLevels.some(next => next.level > lvl.level
        && /^(MANAGEMENT|MGMT)$/i.test(next.role) && !next.useEmployeeManager
        && next.approverId && next.approverId !== employeeId);
    if (approverId && approverId === employeeId && !selfHrVerification) {
      approverId = null;
      reason = "approver is the requester";
      // Never relabel management as HR. An unconfigured independent final
      // approver must block HR self-verification rather than skip the safeguard.
      if (!/^HR$/i.test(lvl.role)) {
        const nextExplicit = selectedLevels
          .filter(l => l.level > lvl.level && !l.useEmployeeManager)
          .sort((a, b) => a.level - b.level)
          .find(l => l.approverId && l.approverId !== employeeId);
        if (nextExplicit) approverId = nextExplicit.approverId;
      }
    }

    out.push({
      level: lvl.level,
      role: lvl.role,
      approverId,
      resolved: Boolean(approverId),
      skippable: /^HR$/i.test(lvl.role) && !approverId && lvl.approverId === employeeId ? false : lvl.skipIfUnresolved,
      selfHrVerification,
      autoEscalateAfterHours: lvl.autoEscalateAfterHours ?? null,
      reason,
      ...(reason === "approver is the requester" && approverId ? { standInForRole: lvl.role } : {}),
    });
  }
  for(const step of out){
    const approver=config.employees.find(e=>e.id===step.approverId);
    if(!approver||!employedOn(approver,config.periods||[],date)){
      step.approverId=null;step.resolved=false;step.reason='Approver is missing or inactive on the request date';
    }
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
    select: { id: true, tenantId: true, employeeId: true, status: true, workflowVersion: true, approvalPolicy: true, currentApprovalLevel: true, createdAt: true, date: true, routingSnapshot: true },
  });
  if (!anomaly || anomaly.tenantId !== tenantId) {
    throw notFound(`Anomaly ${anomalyId} not found in this tenant`);
  }

  const chain = Array.isArray(anomaly.routingSnapshot) ? anomaly.routingSnapshot : await resolveApprovalChain({ tenantId, employeeId: anomaly.employeeId, approvalPolicy: anomaly.approvalPolicy, date: anomaly.date || anomaly.createdAt });
  // HR-RAISED-STARTS-AT-HR (operator, 2026-10-07) — a form HR raised ON BEHALF
  // of an employee starts at HR (skipLevelsBefore=1): the manager step is for
  // the employee's own reporting line, and HR already holds the facts. The
  // employee-submitted path keeps skipLevelsBefore=0 (manager first).
  const eligible = chain.filter((c) => c.level >= (Number(skipLevelsBefore) || 0));
  const target = firstActionableLevel(eligible.length ? eligible : chain);

  if (!target || !target.resolved) {
    await tenantTransaction(prisma,tx=>tx.attendanceAnomaly.update({where:{id:anomalyId},data:{routingSnapshot:chain,currentApprovalLevel:target?.level??null,status:'PENDING',approvalEnteredAt:new Date()}}));
    logger.error(
      { anomalyId, employeeId: anomaly.employeeId, chain },
      "attendance anomaly has no resolvable approver — left PENDING for manual handling",
    );
    return { routed: false, chain, reason: target?.reason ?? "no approval levels configured" };
  }

  const updated = await tenantTransaction(prisma, async (tx) =>
    tx.attendanceAnomaly.update({
      where: { id: anomalyId },
      data: { currentApprovalLevel: target.level, status: "PENDING", routingSnapshot: chain, approvalEnteredAt: new Date() },
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
  const day=dateKey(new Date());
  const config=(await loadAttendanceRuntime({tenantId,from:day,to:day})).configOn(day);
  return config?.approvalLevels?.filter(l=>l.role==='HR'&&l.rowStatus==='ACTIVE').sort((a,b)=>a.level-b.level)[0]?.approverId??null;
}

/**
 * Record one decision and advance, or finalise.
 *
 * REJECTED is terminal at any level: one refusal ends the request, and that is
 * what a DISAPPROVED_LEAVE deduction keys off. APPROVED advances to the next
 * actionable level, and only becomes final once no level remains.
 */
export async function decideAnomaly({ tenantId, anomalyId, approverId, decision, comments }) {
  throw Object.assign(new Error('Use Attendance anomaly review: system-generated per-shift cases, HR missing-time entries, and Management-only decisions'), {status:410});
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
      const chain = Array.isArray(anomaly.routingSnapshot) ? anomaly.routingSnapshot : await resolveApprovalChain({ tenantId, employeeId: anomaly.employeeId, approvalPolicy: anomaly.approvalPolicy, date: anomaly.date || anomaly.createdAt });
      const current = chain.find((c) => c.level === anomaly.currentApprovalLevel);
      if (!current) continue;
      const hers = current.resolved && current.approverId === approverId;
      // HR-DECIDE-ANY-LEVEL — the tenant's HR approver also sees requests parked
      // at a level BEFORE her own HR level (she may verify them there). A request
      // at or after her level follows the normal chain.
      const hrLevel = chain.find((c) => c.role === "HR" && c.approverId === approverId);
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

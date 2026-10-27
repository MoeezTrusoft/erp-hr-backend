// src/services/requisition-approval-chain.service.js
//
// Phase 4 / decision record §2.5 — the approval matrix and the decision that is
// applied against it.
//
// This service owns three things and nothing else:
//   1. the tenant's matrix (list / replace / seed the recommended default),
//   2. resolving the chain for one requisition, and
//   3. applying ONE decision against the next pending step.
//
// The chain is FROZEN at the first decision (`approvalChainSnapshot` on the
// requisition). A matrix edit mid-approval therefore cannot change what an
// in-flight requisition is being judged against, and the decisions already
// recorded keep meaning what they meant. Writing the snapshot lazily rather than
// at submit is deliberate: all three submit paths would otherwise need an extra
// write, and a matrix fixed between submit and first decision SHOULD take effect
// (nobody has signed anything yet).
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData, scopedEmployeeWhere } from "../lib/tenancy.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { requisitionSubmittedEvent } from "./hrEvents.js";
import {
  DEFAULT_CHAIN,
  RULE_ROLES,
  assertChainCanComplete,
  assertNotRequester,
  assertStepDecidable,
  chainProgress,
  nextPendingStep,
  resolveApprovalChain,
} from "../lib/requisition-approval-chain.util.js";

const fail = (message, status, code, details) =>
  Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const toInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const normalize = (value) => String(value ?? "").trim().toUpperCase();

// ── The matrix ──────────────────────────────────────────────────────────────

export const listApprovalRules = async (tenantId, { includeInactive = false } = {}) =>
  prisma.requisitionApprovalRule.findMany({
    where: scopedWhere(tenantId, includeInactive ? {} : { isActive: true }),
    orderBy: { stepOrder: "asc" },
  });

const normalizeRule = (rule, index) => {
  const stepOrder = Number(rule?.stepOrder ?? index + 1);
  if (!Number.isInteger(stepOrder) || stepOrder < 1) {
    throw fail("stepOrder must be a positive integer", 422, "HR-RECRUITMENT-CHAIN-STEP-INVALID");
  }
  const role = normalize(rule?.role);
  if (!RULE_ROLES.includes(role)) {
    throw fail(`role must be one of: ${RULE_ROLES.join(", ")}`, 422, "HR-RECRUITMENT-CHAIN-ROLE-INVALID");
  }
  const minAmount = rule?.minAmount === undefined || rule?.minAmount === null || rule?.minAmount === ""
    ? null
    : Number(rule.minAmount);
  if (minAmount !== null && (!Number.isFinite(minAmount) || minAmount < 0)) {
    throw fail("minAmount must be zero or more", 422, "HR-RECRUITMENT-CHAIN-AMOUNT-INVALID");
  }
  const hiringReason = normalize(rule?.hiringReason) || null;
  return {
    stepOrder,
    role,
    approverId: toInt(rule?.approverId),
    minAmount,
    departmentId: toInt(rule?.departmentId),
    hiringReason,
    requiresDistinctApprover: rule?.requiresDistinctApprover !== false,
    isActive: true,
  };
};

/**
 * Replace the tenant's matrix in one transaction.
 *
 * Replace-all rather than per-row editing: a chain is only coherent as a whole,
 * and a partial edit that leaves two rules on one step order would be rejected by
 * the unique index halfway through — leaving the tenant with a chain that is
 * neither the old one nor the new one.
 *
 * Duplicate step orders are rejected HERE with a readable message rather than
 * surfacing the partial unique index as a Prisma error.
 */
export const setApprovalRules = async (tenantId, rules = []) => {
  const list = Array.isArray(rules) ? rules : [];
  const normalized = list.map(normalizeRule);
  const orders = new Set();
  for (const rule of normalized) {
    if (orders.has(rule.stepOrder)) {
      throw fail(
        `Two approval steps share step order ${rule.stepOrder}; the chain would have no single current step`,
        422,
        "HR-RECRUITMENT-CHAIN-DUPLICATE-STEP",
        { stepOrder: rule.stepOrder },
      );
    }
    orders.add(rule.stepOrder);
  }

  return prisma.$transaction(async (tx) => {
    // Deactivate rather than delete, so a step that was removed from the chain is
    // still readable afterwards — the same reasoning as the hiring freeze.
    await tx.requisitionApprovalRule.updateMany({
      where: scopedWhere(tenantId, { isActive: true }),
      data: { isActive: false },
    });
    for (const rule of normalized) {
      await tx.requisitionApprovalRule.create({ data: scopedData(tenantId, rule) });
    }
    return tx.requisitionApprovalRule.findMany({
      where: scopedWhere(tenantId, { isActive: true }),
      orderBy: { stepOrder: "asc" },
    });
  });
};

/** Store the recommended chain as this tenant's configuration (§2.5). */
export const seedDefaultChain = async (tenantId) => setApprovalRules(tenantId, DEFAULT_CHAIN);

// ── Resolution and the decision ─────────────────────────────────────────────

/**
 * The chain this requisition is being approved against.
 *
 * Prefers the frozen snapshot; falls back to the live matrix. Returns [] for a
 * tenant with no configured rules, which callers must treat as ONE un-stepped
 * decision (the behaviour every tenant has today — see choice 1 in
 * lib/requisition-approval-chain.util.js).
 */
export const chainFor = async (requisition, { db = prisma, tenantId } = {}) => {
  if (Array.isArray(requisition?.approvalChainSnapshot)) return requisition.approvalChainSnapshot;
  const rules = await db.requisitionApprovalRule.findMany({
    where: scopedWhere(tenantId, { isActive: true }),
    orderBy: { stepOrder: "asc" },
  });
  return resolveApprovalChain(requisition, rules);
};

/**
 * Refuse to submit a requisition whose chain could never be completed.
 *
 * Called from the advance guard, so all three submit paths get it. Read-only:
 * nothing is written here (the snapshot is taken at the first decision).
 */
export const assertChainSubmittable = async (tenantId, requisition) => {
  const chain = await chainFor(requisition, { tenantId });
  assertChainCanComplete(chain, requisition);
  return chain;
};

/**
 * Apply ONE approval decision inside the caller's transaction.
 *
 * Returns `{ approved, chainComplete, status, chain, decidedStep }`:
 *   * `status` is what the requisition should be moved to — still
 *     PENDING_APPROVAL when the chain has further steps, so a partial decision
 *     does NOT approve the requisition.
 *   * every step's decision is recorded with its own stepOrder and role.
 */
export const applyApprovalDecision = async (tx, { tenantId, requisition, actorId, comments }) => {
  const decisions = await tx.requisitionApproval.findMany({
    where: scopedWhere(tenantId, { requisitionId: Number(requisition.id) }),
  });
  const chain = await chainFor(requisition, { db: tx, tenantId });
  const step = nextPendingStep(chain, decisions);

  // Unconditional: nobody approves their own requisition. Enforced even for a
  // tenant with NO matrix configured, which is where the original gap was — an
  // unconfigured tenant is a single-step chain, not an unguarded one.
  assertNotRequester(requisition, actorId);

  // A chain of zero steps is the un-stepped single decision: nothing to assign.
  if (chain.length) {
    assertStepDecidable({ step, decisions, actorId });
  }

  const decidedStep = step
    ? { stepOrder: step.stepOrder, role: step.role }
    : { stepOrder: null, role: null };

  await tx.requisitionApproval.create({
    data: scopedData(tenantId, {
      requisitionId: Number(requisition.id),
      approverId: Number(actorId),
      status: "APPROVED",
      comments: comments ?? null,
      decidedAt: new Date(),
      stepOrder: decidedStep.stepOrder,
      role: decidedStep.role,
    }),
  });

  // Freeze the chain at the first decision, so a later matrix edit cannot change
  // what the remaining steps are judged against.
  if (!Array.isArray(requisition?.approvalChainSnapshot) && chain.length) {
    await tx.jobRequisition.update({
      where: { id: Number(requisition.id) },
      data: { approvalChainSnapshot: chain },
    });
  }

  const after = [...decisions, { status: "APPROVED", stepOrder: decidedStep.stepOrder, approverId: Number(actorId) }];
  const chainComplete = chain.length === 0 ? true : nextPendingStep(chain, after) === null;

  return {
    approved: chainComplete,
    chainComplete,
    status: chainComplete ? "APPROVED" : "PENDING_APPROVAL",
    chain: chainProgress(chain, after),
    decidedStep,
  };
};

/**
 * The chain and its progress for a requisition, for the detail views.
 * Uses the frozen snapshot when there is one, so a submitted requisition reports
 * the chain it is actually being approved against.
 */
export const chainStatusFor = async (tenantId, requisition) => {
  const chain = await chainFor(requisition, { tenantId });
  const decisions = await prisma.requisitionApproval.findMany({
    where: scopedWhere(tenantId, { requisitionId: Number(requisition.id) }),
  });
  return chainProgress(chain, decisions);
};

// ── Submit-time event with approver routing ─────────────────────────────────

/**
 * Phase 4 closure — emit `hr.recruitment.requisition_submitted.v1` with the
 * routing id the notification hub needs.
 *
 * The hub left this event deliberately unmapped because Phase 4 (the chain)
 * did not exist and the payload carried no approver. Both gaps are closed: the
 * builder now accepts the routing fields, and this helper resolves them off the
 * SAME chain resolution the decision path uses — so the notified approver and
 * the gate that will judge the decision cannot disagree.
 *
 * Routing rule:
 *   * first pending step with a pinned approver  → that employee id;
 *   * chain of zero steps (tenant with no matrix) → null: the single un-stepped
 *     decision has no pre-known actor, the hub skips the in-app copy, and the
 *     requester's own "submitted" record plus the decide endpoint's authz is
 *     what routes it;
 *   * first step names only a role               → null: the tenant routes
 *     role-based decisions through its own directory, inventing one here would
 *     be wrong.
 *
 * Caller MUST call inside its transaction (the outbox row joins the status
 * flip). Fire-and-forget by contract: enqueueHrDomainEvent never throws past
 * its own guards, and a routing miss degrades to null rather than failing a
 * submission that the gate already accepted.
 */
export const emitRequisitionSubmittedEvent = async (tx, { tenantId, requisition, actorId = null }) => {
  // The HR Approval Centre reviews every requisition with the same chain, and
  // its first reviewer is the requester's direct line manager. Route the
  // recruitment event to that person (stage 1); the centre's own
  // hr.approval.transitioned.v1 events cover the later stages.
  const requester = requisition?.requestedById
    ? await tx.employee.findFirst({
        where: scopedEmployeeWhere(tenantId, { id: Number(requisition.requestedById) }),
        select: { managerId: true },
      })
    : null;
  const managerId = requester?.managerId ?? null;
  await enqueueHrDomainEvent(
    tx,
    requisitionSubmittedEvent(
      requisition,
      { actorId },
      {
        pendingApproverId: managerId,
        pendingStepOrder: managerId ? 1 : null,
      },
    ),
  );
};

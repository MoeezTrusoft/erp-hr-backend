import { legacyDecision } from "./approval/legacy.js";
import prisma from "../config/prisma.js";
import { scopedData, scopedWhere } from "../lib/tenancy.js";
import {
  DEFAULT_OFFER_APPROVAL_RULES,
  OFFER_APPROVAL_STAGES,
  resolveOfferApprovalChain,
  validateOfferApprovalRules,
} from "../lib/offerApprovalPolicy.js";

export { OFFER_APPROVAL_STAGES };

const policyError = (message, code) => Object.assign(new Error(message), { status: 422, code });

const approvalError = (message, code = "HR-RECRUITMENT-OFFER-APPROVAL") =>
  Object.assign(new Error(message), { status: 409, code });

const requireTenant = (tenantId) => {
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
  }
};

// ── The tenant offer approval policy (FR-09 residue) ────────────────────────

/**
 * The tenant's ACTIVE rules, plus the chain they resolve to for an offer of the
 * given amount so a configuration screen can show the effect before saving.
 */
export async function getOfferApprovalPolicy({ tenantId, amount = null, currency = null, db = prisma } = {}) {
  requireTenant(tenantId);
  const rules = await db.offerApprovalRule.findMany({
    where: scopedWhere(tenantId, { isActive: true }),
    orderBy: { stepOrder: "asc" },
  });
  const resolved = resolveOfferApprovalChain({
    rules: rules.map(toPolicyRule),
    amount,
    currency,
  });
  return {
    configured: rules.length > 0,
    rules,
    stages: OFFER_APPROVAL_STAGES,
    resolvedChain: resolved.steps.map((s) => s.stage),
    resolvedSource: resolved.source,
    defaultChain: DEFAULT_OFFER_APPROVAL_RULES.map((r) => r.stage),
  };
}

/**
 * Replace the tenant's policy in one transaction (deactivate-then-create, so a
 * rule removed from the chain stays readable afterwards — same reasoning as the
 * requisition matrix). An EMPTY list is refused: "no rules" means "fall back to
 * the default triple", and allowing it would make a saved policy silently
 * indistinguishable from an unconfigured tenant.
 */
export async function setOfferApprovalPolicy({ tenantId, rules = [], createdById = null, db = prisma } = {}) {
  requireTenant(tenantId);
  const candidate = (Array.isArray(rules) ? rules : []).map((rule) => ({
    stepOrder: Number(rule?.stepOrder),
    stage: String(rule?.stage ?? "").trim(),
    role: rule?.role ?? null,
    minAmount: rule?.minAmount ?? null,
    maxAmount: rule?.maxAmount ?? null,
    currency: rule?.currency ?? null,
  }));
  const validated = validateOfferApprovalRules(candidate);
  if (!validated.ok) {
    throw policyError(validated.error, "HR-RECRUITMENT-OFFER-POLICY-INVALID");
  }

  return db.$transaction(async (tx) => {
    await tx.offerApprovalRule.updateMany({
      where: scopedWhere(tenantId, { isActive: true }),
      data: { isActive: false },
    });
    for (const rule of validated.rules) {
      await tx.offerApprovalRule.create({
        data: scopedData(tenantId, {
          stepOrder: rule.stepOrder,
          stage: rule.stage,
          role: rule.role,
          minAmount: rule.minAmount,
          maxAmount: rule.maxAmount,
          currency: rule.currency,
          isActive: true,
          createdById: Number.isInteger(Number(createdById)) ? Number(createdById) : null,
        }),
      });
    }
    return tx.offerApprovalRule.findMany({
      where: scopedWhere(tenantId, { isActive: true }),
      orderBy: { stepOrder: "asc" },
    });
  });
}

const toPolicyRule = (row) => ({
  stepOrder: row.stepOrder,
  stage: row.stage,
  role: row.role ?? null,
  minAmount: row.minAmount === null || row.minAmount === undefined ? null : Number(row.minAmount),
  maxAmount: row.maxAmount === null || row.maxAmount === undefined ? null : Number(row.maxAmount),
  currency: row.currency ?? null,
});

/**
 * The stages THIS offer must satisfy, resolved from the live policy and the
 * offer's own compensation. Falls back to the default triple for an
 * unconfigured tenant, so behavior is unchanged until a policy is set.
 */
export async function requiredStagesForOffer({ offerId, tenantId, db = prisma } = {}) {
  requireTenant(tenantId);
  const offer = await db.offer.findFirst({
    where: scopedWhere(tenantId, { id: Number(offerId) }),
    select: { id: true, salary: true, currency: true },
  });
  if (!offer) throw Object.assign(new Error("Offer not found"), { status: 404 });

  const rules = await db.offerApprovalRule.findMany({
    where: scopedWhere(tenantId, { isActive: true }),
    orderBy: { stepOrder: "asc" },
  });
  return resolveOfferApprovalChain({
    rules: rules.map(toPolicyRule),
    amount: offer.salary,
    currency: offer.currency,
  });
}

export async function approveOffer({ offerId } = {}) {
  return legacyDecision('OFFER', offerId);
}

export async function assertOfferApproved({ offerId, tenantId, db = prisma } = {}) {
  requireTenant(tenantId);
  const offer = await db.offer.findFirst({
    where: scopedWhere(tenantId, { id: Number(offerId) }),
    select: { id: true, status: true, approvalStatus: true },
  });
  if (!offer) throw Object.assign(new Error("Offer not found"), { status: 404 });
  if (offer.status !== "DRAFT") {
    throw approvalError(`Only DRAFT offers can be sent (current status: ${offer.status})`, "HR-RECRUITMENT-OFFER-STATUS");
  }
  if (offer.approvalStatus !== "APPROVED") {
    throw approvalError("Offer must receive all required approvals before it can be sent", "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED");
  }

  // Re-derive the required set rather than trusting the stored status: the
  // policy can change between the LAST decision and the send, and a status
  // computed under the old policy must not authorise a send under the new one.
  const { steps, source } = await requiredStagesForOffer({ offerId: offer.id, tenantId, db });
  const approvals = await db.offerApproval.findMany({
    where: { offerId: offer.id, tenantId },
    select: { stage: true, decision: true },
  });
  const missing = steps
    .map((step) => step.stage)
    .filter((required) => !approvals.some((item) => item.stage === required && item.decision === "APPROVED"));
  if (missing.length > 0) {
    throw approvalError(
      `Offer approval policy requires approval from: ${missing.join(", ")}`,
      "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED",
    );
  }
  return { ...offer, requiredStages: steps.map((step) => step.stage), requiredSource: source };
}

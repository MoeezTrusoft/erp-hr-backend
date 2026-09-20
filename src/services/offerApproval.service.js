import prisma from "../config/prisma.js";
import { scopedWhere } from "../lib/tenancy.js";

export const OFFER_APPROVAL_STAGES = Object.freeze(["hiringManager", "hrHead", "finance"]);

const approvalError = (message, code = "HR-RECRUITMENT-OFFER-APPROVAL") =>
  Object.assign(new Error(message), { status: 409, code });

const requireTenant = (tenantId) => {
  if (tenantId === undefined || tenantId === null || tenantId === "") {
    throw Object.assign(new Error("Tenant context is required"), { status: 400, code: "HR-TENANT-REQUIRED" });
  }
};

export async function approveOffer({ offerId, stage, decision, reason, approverId, tenantId, db = prisma } = {}) {
  requireTenant(tenantId);
  const normalizedStage = String(stage || "").trim();
  const normalizedDecision = String(decision || "").trim().toUpperCase();
  if (!OFFER_APPROVAL_STAGES.includes(normalizedStage)) {
    throw approvalError(`Unsupported offer approval stage: ${normalizedStage}`, "HR-RECRUITMENT-OFFER-APPROVAL-STAGE");
  }
  if (!["APPROVED", "REJECTED"].includes(normalizedDecision)) {
    throw approvalError("Offer approval decision must be APPROVED or REJECTED", "HR-RECRUITMENT-OFFER-DECISION");
  }
  if (normalizedDecision === "REJECTED" && !String(reason || "").trim()) {
    throw approvalError("Rejected offer approvals require a reason", "HR-RECRUITMENT-OFFER-REASON-REQUIRED");
  }

  const offer = await db.offer.findFirst({
    where: scopedWhere(tenantId, { id: Number(offerId) }),
    select: { id: true, status: true, approvalStatus: true },
  });
  if (!offer) throw Object.assign(new Error("Offer not found"), { status: 404 });
  if (["SENT", "ACCEPTED", "DECLINED"].includes(offer.status)) {
    throw approvalError("Offer approvals cannot change after the offer has been sent", "HR-RECRUITMENT-OFFER-IMMUTABLE");
  }

  const record = await db.offerApproval.upsert({
    where: { offerId_stage: { offerId: offer.id, stage: normalizedStage } },
    create: {
      offerId: offer.id,
      tenantId,
      stage: normalizedStage,
      decision: normalizedDecision,
      approverId: Number.isInteger(Number(approverId)) ? Number(approverId) : null,
      reason: String(reason || "").trim() || null,
    },
    update: {
      tenantId,
      decision: normalizedDecision,
      approverId: Number.isInteger(Number(approverId)) ? Number(approverId) : null,
      reason: String(reason || "").trim() || null,
      decidedAt: new Date(),
    },
  });

  const approvals = await db.offerApproval.findMany({
    where: { offerId: offer.id, tenantId },
    select: { stage: true, decision: true },
  });
  const rejected = approvals.some((item) => item.decision === "REJECTED");
  const fullyApproved = OFFER_APPROVAL_STAGES.every((required) =>
    approvals.some((item) => item.stage === required && item.decision === "APPROVED")
  );
  const approvalStatus = rejected ? "REJECTED" : fullyApproved ? "APPROVED" : "PENDING";

  await db.offer.update({
    where: { id: offer.id },
    data: { approvalStatus },
  });
  return { approval: record, approvalStatus, requiredStages: OFFER_APPROVAL_STAGES };
}

export async function assertOfferApproved({ offerId, tenantId, db = prisma } = {}) {
  requireTenant(tenantId);
  const offer = await db.offer.findFirst({
    where: scopedWhere(tenantId, { id: Number(offerId) }),
    select: { id: true, status: true, approvalStatus: true },
  });
  if (!offer) throw Object.assign(new Error("Offer not found"), { status: 404 });
  if (offer.approvalStatus !== "APPROVED") {
    throw approvalError("Offer must receive all required approvals before it can be sent", "HR-RECRUITMENT-OFFER-APPROVAL-REQUIRED");
  }
  if (offer.status !== "DRAFT") {
    throw approvalError(`Only DRAFT offers can be sent (current status: ${offer.status})`, "HR-RECRUITMENT-OFFER-STATUS");
  }
  return offer;
}

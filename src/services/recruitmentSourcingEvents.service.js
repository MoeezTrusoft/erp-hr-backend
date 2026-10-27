import { getCtx } from "../mcp/context.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
// Realtime consumers re-fetch their scoped view; contact and bonus notes stay private.
export function referralChanged(tx, row) {
  const ctx = getCtx();
  return enqueueHrDomainEvent(tx, {
    eventName: "hr.recruitment.referral_changed.v1",
    aggregateType: "InternalReferral",
    aggregateId: row.id,
    tenantId: row.tenantId,
    actorId: ctx.user?.userId || "erp-hr",
    actorType: ctx.actorVerified && !ctx.system ? "user" : "service",
    correlationId: ctx.correlationId,
    payload: { referralId: row.id, version: row.version },
  });
}

export function agencyChanged(tx, row) {
  const ctx = getCtx();
  return enqueueHrDomainEvent(tx, {
    eventName: "hr.recruitment.agency_changed.v1",
    aggregateType: row.submissionId ? "AgencySubmission" : "RequisitionAgencyAssignment",
    aggregateId: row.submissionId || row.agencyId + ":" + row.requisitionId,
    tenantId: row.tenantId,
    actorId: ctx.user?.userId || "erp-hr",
    actorType: ctx.actorVerified && !ctx.system ? "user" : "service",
    correlationId: ctx.correlationId,
    payload: {
      agencyId: row.agencyId,
      requisitionId: String(row.requisitionId),
      submissionId: row.submissionId || null,
      version: row.version,
    },
  });
}

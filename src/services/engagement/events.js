// src/services/engagement/events.js — outbox emission for the engine
// (ARCH-01 §7–§8: validated envelope written in the SAME transaction).
// Names follow `domain.entity.action.vN` (three dotted atoms before vN).
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";

export const EVENTS = Object.freeze({
  EVENT_INGESTED: "engagement.event.ingested.v1",
  PROFILE_REFRESHED: "engagement.profile.refreshed.v1",
  DOCUMENT_GENERATED: "engagement.document.generated.v1",
  DOCUMENT_TRANSITIONED: "engagement.document.transitioned.v1",
  PROJECT_PROPOSED: "engagement.project.proposed.v1",
  PROJECT_SYNCED: "engagement.project.synced.v1",
  PARTY_MERGED: "engagement.party.merged.v1",
});

/** Ids-only payloads (ARCH-01 §13): never put bodies or PII on the fabric. */
export async function emit(tx, env, eventName, { aggregateType, aggregateId, payload }) {
  return enqueueHrDomainEvent(tx, {
    eventName,
    tenantId: env.tenantId,
    actorId: env.actorId || "engagement-engine",
    actorType: env.user?.userId != null ? "user" : "service",
    correlationId: env.correlationId,
    aggregateType,
    aggregateId,
    payload: { tenantId: env.tenantId, ...payload },
  });
}

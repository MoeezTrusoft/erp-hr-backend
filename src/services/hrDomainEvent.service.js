// src/services/hrDomainEvent.service.js — M1-HR fan-out (WBS-MODULES §M1).
//
// Generic transactional-outbox writer for HR DOMAIN events beyond the
// employee lifecycle: leave / payroll / attendance / recruitment / performance.
// It is the sibling of employeeOutbox.service.js (which owns the bespoke
// hr.employee.lifecycle.v1 mapping); this module is the reusable path every
// other aggregate write uses to publish a fabric event.
//
// CONTRACT CONFORMANCE (validate-before-write — ARCH-01 §7–§8 / ARCH-06 §7):
//   * The wrapping EventEnvelope is parsed STRICT against @trusoft/contracts
//     (envelope). A non-conformant envelope (bad name grammar, non-uuid tenant,
//     missing actor, …) THROWS and rolls back the surrounding aggregate tx, so a
//     malformed event can never escape the transaction.
//   * The per-type PAYLOAD is parsed against the contract EVENT_REGISTRY when a
//     schema exists for the event name (e.g. hr.employee.lifecycle.v1). For the
//     newly-fanned-out HR names that A-CON has not yet ratified (REQ filed),
//     only the envelope is validated — the C-03 tolerant-read posture: the
//     fabric carries the envelope, consumers `eventPayloadSchema(name)?.parse`.
//   * EventEnvelope.correlationId threads the REQUEST correlation id (A.5) so a
//     business action is traceable HTTP-edge → event end-to-end; it is minted
//     only when the caller supplies none.
//
// The same claim/lease dispatcher (src/jobs/outbox.dispatcher.js) drains these
// rows and XADDs the persisted envelope onto the `hr:events` Redis stream — no
// per-event dispatcher wiring is needed because the OutboxEvent table and the
// dispatcher are event-name-agnostic.
//
// Fail-soft: when the prisma client has no OutboxEvent model (unit-test mocks),
// return null + warn rather than throw — the source aggregate write still
// succeeds. Fail-closed: an absent tenantId returns null (an event with no
// tenant can never be contract-valid and must not break the aggregate write).
// Hard error: a contract failure (rethrow) so the tx rolls back.
import { randomUUID } from 'node:crypto';

import { EventEnvelope } from '@trusoft/contracts/envelopes';
import { eventPayloadSchema } from '@trusoft/contracts/events';

import logger from '../lib/logger.js';

// Payload schema version (EventEnvelope.version — independent of the name's vN).
const DEFAULT_PAYLOAD_VERSION = 1;

/**
 * Build + strict-parse the EventEnvelope wrapping an HR domain-event payload.
 * Where the contract registry knows the event name, the payload is parsed too
 * (registry-strict); otherwise the envelope alone is the conformance boundary
 * (C-03 tolerant-read). Throws (ZodError) on any contract violation.
 *
 * @param {object} args
 * @param {string} args.eventName       canonical `hr.<entity>.<action>.vN`.
 * @param {string} args.tenantId        TenantId (UUID).
 * @param {string} args.actorId         acting principal id (user/service).
 * @param {object} args.payload         the event payload (object).
 * @param {string} [args.occurredAt]    ISO instant; defaults to now.
 * @param {string} [args.correlationId] request-chain id; minted only if absent.
 * @param {string} [args.causationId]   parent event id (optional).
 * @param {number} [args.version]       payload schema version (default 1).
 * @param {('user'|'service'|'automation')} [args.actorType='service']
 * @returns {object} an EventEnvelope-parsed envelope.
 */
export function buildHrEventEnvelope({
    eventName,
    tenantId,
    actorId,
    payload,
    occurredAt,
    correlationId,
    causationId,
    version = DEFAULT_PAYLOAD_VERSION,
    actorType = 'service',
}) {
    // Registry-strict payload check when the contract knows this event name.
    // Unknown (not-yet-ratified) names fall through to envelope-only validation.
    const payloadSchema = eventPayloadSchema(eventName);
    const checkedPayload = payloadSchema ? payloadSchema.parse(payload) : payload;

    const envelope = {
        id: randomUUID(),
        name: eventName,
        occurredAt: occurredAt || new Date().toISOString(),
        tenantId,
        actor: { type: actorType, id: actorId != null ? String(actorId) : 'erp-hr' },
        correlationId: correlationId || randomUUID(),
        version,
        payload: checkedPayload,
    };
    if (causationId != null) envelope.causationId = String(causationId);

    return EventEnvelope.parse(envelope);
}

/**
 * Enqueue an HR domain-event EventEnvelope row inside an active tx.
 *
 * The envelope (and, when registered, the payload) is validated BEFORE the
 * write; a contract failure throws and rolls back the tx — a non-conformant
 * event never leaves the transaction. The dispatcher publishes the row
 * at-least-once; the consumer dedupes on EventEnvelope.id.
 *
 * @param {object} tx   Prisma transaction client (must expose outboxEvent.create).
 * @param {object} args buildHrEventEnvelope input PLUS:
 *   aggregateType (e.g. 'LeaveRequest'), aggregateId (source row id).
 * @returns {Promise<object|null>} the created outbox row, or null when the
 *   OutboxEvent model is unavailable (test mocks) or tenantId is absent.
 */
export async function enqueueHrDomainEvent(tx, args) {
    // Fail-closed: an event with no tenant can never be contract-valid; skip it
    // rather than break the surrounding aggregate write.
    if (!args?.tenantId) {
        logger.warn(
            { eventName: args?.eventName },
            'hr domain event: missing tenantId — skipping outbox enqueue (fail-closed)'
        );
        return null;
    }

    const writer = tx?.outboxEvent;
    if (!writer?.create) {
        logger.warn(
            { tenantId: args?.tenantId, eventName: args?.eventName },
            'OutboxEvent model unavailable on prisma client — skipping outbox enqueue'
        );
        return null;
    }

    // Validate-before-write: throwing aborts the enqueue (and the surrounding tx).
    const envelope = buildHrEventEnvelope(args);

    return writer.create({
        data: {
            tenantId: envelope.tenantId,
            eventName: envelope.name,
            aggregateType: args.aggregateType != null ? String(args.aggregateType) : 'Hr',
            aggregateId: args.aggregateId != null
                ? String(args.aggregateId)
                : String(envelope.id),
            payload: envelope,
        },
    });
}

export default enqueueHrDomainEvent;

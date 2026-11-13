// src/services/employeeOutbox.service.js — A.4 · ARCH-01 §7–§8.
//
// Writes the `hr.employee.lifecycle.v1` event into the transactional outbox
// (model OutboxEvent) INSIDE the same transaction as the Employee aggregate
// write. The payload AND its EventEnvelope wrapper are parsed against
// @trusoft/contracts BEFORE the row is written (validate-before-write): an
// event that fails its own contract throws, rolling back the surrounding tx
// alongside the source aggregate, so a non-conformant event can never escape.
//
// CONTRACT CONFORMANCE:
//   * payload  → HrEmployeeLifecycleV1 (ids-only; ARCH-01 §13). Strict parse.
//   * envelope → EventEnvelope (ARCH-01 §10.2 / ARCH-06 §7). Strict parse.
//   * EventEnvelope.correlationId is the REQUEST correlation id (A.5) so the
//     business action is traceable HTTP-edge → event end-to-end. It is NOT a
//     freshly-minted id unless the caller supplies none.
//
// A separate claim/lease dispatcher (src/jobs/outbox.dispatcher.js) drains
// unpublished rows and XADDs the persisted envelope to a Redis stream.
//
// Fail-soft: when the prisma client has no OutboxEvent model (unit-test mocks),
// return null + warn rather than throw — the source write still succeeds.
// Hard error: a contract failure (rethrow) so the tx rolls back.
import crypto, { randomUUID } from 'node:crypto';

import { HrEmployeeLifecycleV1 } from '@trusoft/contracts/events';
import { EventEnvelope } from '@trusoft/contracts/envelopes';

import logger from '../lib/logger.js';

export const HR_EMPLOYEE_LIFECYCLE_V1 = 'hr.employee.lifecycle.v1';

// Payload schema version (EventEnvelope.version — independent of the name's vN).
const PAYLOAD_VERSION = 1;

// Fixed DNS namespace for deriving stable UUIDv5s for ids HR holds as Ints.
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * Deterministic UUIDv5 from an arbitrary string under a fixed namespace. Used
 * to bridge HR's Int-keyed aggregates (Employee.id, businessUnitId) to the
 * contract's required Uuid ids — same identity always yields the same id, so
 * the emitted event is contract-valid AND stable across retries. This mirrors
 * the comms BigInt→UUIDv5 bridge; a real UUID surrogate column is the tracked
 * long-term fix.
 */
export function deterministicUuid(name, namespace = UUID_NAMESPACE) {
    const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const hash = crypto.createHash('sha1');
    hash.update(nsBytes);
    hash.update(Buffer.from(String(name), 'utf8'));
    const bytes = hash.digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = Buffer.from(bytes).toString('hex');
    return (
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
        `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
    );
}

function toCalendarDate(value) {
    if (value == null) return new Date().toISOString().slice(0, 10);
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
}

/**
 * Map an HR Employee row (Int id, no UUID surrogate, no native orgUnit UUID)
 * onto the ids-only HrEmployeeLifecycleV1 input. Required UUID ids that HR
 * holds as Ints are derived deterministically (see deterministicUuid). The
 * returned object is the input to buildEmployeeLifecyclePayload / enqueue.
 *
 * @param {object} employee  the persisted Employee row.
 * @param {string} phase     lifecycle phase (hired|transferred|on_leave|returned|terminated).
 * @param {object} [extra]   optional phase facts (terminationCause, leaveType,
 *   previousOrgUnitId, effectiveOn override) and identity overrides.
 * @returns {object} a HrEmployeeLifecycleV1 input.
 */
export function mapEmployeeToLifecycleInput(employee, phase, extra = {}) {
    const tenantId = employee?.tenant_id ?? extra.tenantId;
    const given = employee?.first_name || employee?.employee_name || 'Unknown';
    const family = employee?.last_name || '-';
    // Org unit: HR groups people by businessUnitId / positionId (Ints). Derive a
    // stable UUID so the required contract field is satisfied deterministically.
    const orgUnitSource = employee?.businessUnitId ?? employee?.positionId ?? 'unassigned';

    const input = {
        tenantId,
        employeeId: deterministicUuid(`hr:employee:${tenantId}:${employee?.id}`),
        employeeNumber: String(employee?.employee_code || employee?.id || 'unknown'),
        name: { given, family },
        orgUnitId: deterministicUuid(`hr:orgunit:${tenantId}:${orgUnitSource}`),
        phase,
        effectiveOn: toCalendarDate(extra.effectiveOn ?? employee?.hire_date),
    };
    if (employee?.work_email) input.workEmail = employee.work_email;
    if (extra.terminationCause != null) input.terminationCause = extra.terminationCause;
    if (extra.leaveType != null) input.leaveType = extra.leaveType;
    if (extra.previousOrgUnitId != null) input.previousOrgUnitId = extra.previousOrgUnitId;
    return input;
}

/**
 * Build + strict-parse the HrEmployeeLifecycleV1 payload (validate-before-write).
 * Throws (ZodError) when the input cannot satisfy the contract.
 *
 * @param {object} input  see HrEmployeeLifecycleV1 (tenantId, employeeId,
 *   employeeNumber, name, orgUnitId, phase, effectiveOn, + optional facts).
 * @returns {object} the canonical (branded) payload.
 */
export function buildEmployeeLifecyclePayload(input) {
    const draft = {
        tenantId: input.tenantId,
        employeeId: input.employeeId,
        employeeNumber: input.employeeNumber,
        name: input.name,
        orgUnitId: input.orgUnitId,
        phase: input.phase,
        effectiveOn: input.effectiveOn,
    };
    // Optional ids/facts only when present (the schema is .strict()).
    if (input.userId != null) draft.userId = input.userId;
    if (input.workEmail != null) draft.workEmail = input.workEmail;
    if (input.previousOrgUnitId != null) draft.previousOrgUnitId = input.previousOrgUnitId;
    if (input.leaveType != null) draft.leaveType = input.leaveType;
    if (input.terminationCause != null) draft.terminationCause = input.terminationCause;

    return HrEmployeeLifecycleV1.parse(draft);
}

/**
 * Build + strict-parse the EventEnvelope wrapping a lifecycle payload (COMM-02
 * peer). Threads the REQUEST correlationId so the chain is unbroken (A.5).
 * Throws (ZodError) when the envelope is not conformant.
 *
 * @param {object} args
 * @param {object} args.payload          a HrEmployeeLifecycleV1 payload.
 * @param {string} args.tenantId         TenantId (UUID).
 * @param {string} args.actorId          actor id (the user/service that acted).
 * @param {string} args.occurredAt       ISO instant.
 * @param {string} [args.correlationId]  request-chain id; minted only if absent.
 * @returns {object} an EventEnvelope-parsed envelope.
 */
export function buildEmployeeLifecycleEnvelope({ payload, tenantId, actorId, occurredAt, correlationId }) {
    const envelope = {
        id: randomUUID(),
        name: HR_EMPLOYEE_LIFECYCLE_V1,
        occurredAt,
        tenantId,
        // HR raises lifecycle events as the service; actor.id is the acting
        // principal (resolved from req context by the caller).
        actor: { type: 'service', id: actorId != null ? String(actorId) : 'erp-hr' },
        correlationId: correlationId || randomUUID(),
        version: PAYLOAD_VERSION,
        payload,
    };
    return EventEnvelope.parse(envelope);
}

/**
 * Enqueue a hr.employee.lifecycle.v1 EventEnvelope row inside an active tx.
 *
 * The payload AND envelope are validated BEFORE the write; a contract failure
 * throws and rolls back the tx — a non-conformant event never leaves the
 * transaction. Idempotency is enforced downstream by the consumer keying on
 * EventEnvelope.id; at the producer side the row is the single source of truth
 * the dispatcher publishes at-least-once.
 *
 * @param {object} tx   Prisma transaction client (must expose outboxEvent.create).
 * @param {object} args buildEmployeeLifecyclePayload input PLUS:
 *   actorId, occurredAt (defaults to now), correlationId.
 * @returns {Promise<object|null>} the created outbox row, or null when the
 *   OutboxEvent model is unavailable (test mocks).
 */
export async function enqueueEmployeeLifecycle(tx, args) {
    const writer = tx?.outboxEvent;
    if (!writer?.create) {
        logger.warn(
            { tenantId: args?.tenantId, eventName: HR_EMPLOYEE_LIFECYCLE_V1 },
            'OutboxEvent model unavailable on prisma client — skipping outbox enqueue'
        );
        return null;
    }

    // Validate-before-write: payload first, then envelope. Either throwing
    // aborts the enqueue (and the surrounding tx).
    const payload = buildEmployeeLifecyclePayload(args);
    const occurredAt = args.occurredAt
        || (args.effectiveOn ? new Date(`${args.effectiveOn}T00:00:00.000Z`).toISOString() : new Date().toISOString());
    const envelope = buildEmployeeLifecycleEnvelope({
        payload,
        tenantId: payload.tenantId,
        actorId: args.actorId,
        occurredAt,
        correlationId: args.correlationId,
    });

    return writer.create({
        data: {
            tenantId: payload.tenantId,
            eventName: HR_EMPLOYEE_LIFECYCLE_V1,
            aggregateType: 'Employee',
            aggregateId: args.aggregateId != null
                ? String(args.aggregateId)
                : String(payload.employeeId),
            payload: envelope,
        },
    });
}

export default enqueueEmployeeLifecycle;

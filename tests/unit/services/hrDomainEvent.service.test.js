// tests/unit/services/hrDomainEvent.service.test.js
//
// M1-HR (WBS-MODULES §M1 · audit-05 HR-BE) — fan-out outbox event producers
// beyond employee-lifecycle. The generic writer enqueues a CONTRACT-VALID
// EventEnvelope for leave / payroll / attendance / recruitment / performance
// domain events into the OutboxEvent table, validate-before-write.
//
// Proves:
//   * the EventEnvelope wrapping the payload is parsed STRICT against the
//     contract (a non-conformant envelope never reaches the DB),
//   * the event NAME must match the canonical domain.entity.action.vN grammar,
//   * where EVENT_REGISTRY has a payload schema, the payload is parsed too;
//     otherwise the envelope-only check applies (C-03 tolerant-read posture),
//   * EventEnvelope.correlationId is the REQUEST correlation id (A.5),
//   * the row is written via the passed tx client (atomicity),
//   * a contract violation THROWS (rolls back the surrounding tx),
//   * the model-unavailable path fails soft (returns null + warns).
import { describe, it, expect, jest } from '@jest/globals';

import {
    buildHrEventEnvelope,
    enqueueHrDomainEvent,
} from '../../../src/services/hrDomainEvent.service.js';

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const ACTOR = '77777777-2222-4333-8444-555555555555';

describe('buildHrEventEnvelope (validate-before-write)', () => {
    it('wraps a payload in a conformant EventEnvelope threading the request correlationId', () => {
        const envelope = buildHrEventEnvelope({
            eventName: 'hr.leave.approved.v1',
            tenantId: TENANT,
            actorId: ACTOR,
            occurredAt: '2026-06-25T10:00:00.000Z',
            correlationId: 'req-corr-leave',
            payload: { leaveRequestId: 'lr-1', employeeId: 'e-1', status: 'APPROVED' },
        });

        expect(envelope.name).toBe('hr.leave.approved.v1');
        expect(envelope.correlationId).toBe('req-corr-leave'); // NOT minted
        expect(envelope.tenantId).toBe(TENANT);
        expect(envelope.actor.type).toBe('service');
        expect(envelope.payload.status).toBe('APPROVED');
        expect(envelope.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
    });

    it('throws when the event name violates the canonical grammar', () => {
        expect(() =>
            buildHrEventEnvelope({
                eventName: 'NotAValidName',
                tenantId: TENANT,
                actorId: ACTOR,
                occurredAt: '2026-06-25T10:00:00.000Z',
                payload: { x: 1 },
            })
        ).toThrow();
    });

    it('throws when the tenantId is not a uuid (envelope contract)', () => {
        expect(() =>
            buildHrEventEnvelope({
                eventName: 'hr.payroll.run_finalized.v1',
                tenantId: 'not-a-uuid',
                actorId: ACTOR,
                occurredAt: '2026-06-25T10:00:00.000Z',
                payload: { runId: 'r-1' },
            })
        ).toThrow();
    });

    it('mints a correlationId only when none is supplied', () => {
        const envelope = buildHrEventEnvelope({
            eventName: 'hr.attendance.recorded.v1',
            tenantId: TENANT,
            actorId: ACTOR,
            occurredAt: '2026-06-25T10:00:00.000Z',
            payload: { employeeId: 'e-1', action: 'checkin' },
        });
        expect(typeof envelope.correlationId).toBe('string');
        expect(envelope.correlationId.length).toBeGreaterThan(0);
    });
});

describe('enqueueHrDomainEvent', () => {
    it('writes a validated EventEnvelope row via the tx client', async () => {
        const create = jest.fn(async (args) => ({ id: 'outbox-X', ...args.data }));
        const tx = { outboxEvent: { create } };

        const row = await enqueueHrDomainEvent(tx, {
            eventName: 'hr.recruitment.candidate_hired.v1',
            tenantId: TENANT,
            aggregateType: 'Candidate',
            aggregateId: 42,
            actorId: ACTOR,
            occurredAt: '2026-06-25T10:00:00.000Z',
            correlationId: 'corr-hire',
            payload: { candidateId: 'c-1', employeeId: 'e-1' },
        });

        expect(create).toHaveBeenCalledTimes(1);
        const data = create.mock.calls[0][0].data;
        expect(data.eventName).toBe('hr.recruitment.candidate_hired.v1');
        expect(data.aggregateType).toBe('Candidate');
        expect(data.aggregateId).toBe('42'); // stringified
        expect(data.tenantId).toBe(TENANT);
        expect(data.payload.name).toBe('hr.recruitment.candidate_hired.v1');
        expect(data.payload.correlationId).toBe('corr-hire');
        expect(row.id).toBe('outbox-X');
    });

    it('throws (rolls back) when the event is not contract-conformant', async () => {
        const create = jest.fn();
        const tx = { outboxEvent: { create } };

        await expect(
            enqueueHrDomainEvent(tx, {
                eventName: 'bad name with spaces',
                tenantId: TENANT,
                actorId: ACTOR,
                payload: { x: 1 },
            })
        ).rejects.toThrow();
        expect(create).not.toHaveBeenCalled();
    });

    it('skips (returns null) when tenantId is absent — fail-closed, never breaks the aggregate write', async () => {
        const create = jest.fn();
        const tx = { outboxEvent: { create } };
        const row = await enqueueHrDomainEvent(tx, {
            eventName: 'hr.performance.review_finalized.v1',
            tenantId: null,
            actorId: ACTOR,
            payload: { reviewId: 'rv-1' },
        });
        expect(row).toBeNull();
        expect(create).not.toHaveBeenCalled();
    });

    it('fails soft (returns null) when the outbox model is unavailable', async () => {
        const row = await enqueueHrDomainEvent({}, {
            eventName: 'hr.leave.approved.v1',
            tenantId: TENANT,
            actorId: ACTOR,
            payload: { leaveRequestId: 'lr-1' },
        });
        expect(row).toBeNull();
    });

    it('validates the payload against EVENT_REGISTRY when a schema exists for the name', async () => {
        const create = jest.fn(async (args) => ({ id: 'outbox-reg', ...args.data }));
        const tx = { outboxEvent: { create } };

        // hr.employee.lifecycle.v1 HAS a registered payload schema; a payload
        // missing required fields must THROW (registry-strict), not silently pass.
        await expect(
            enqueueHrDomainEvent(tx, {
                eventName: 'hr.employee.lifecycle.v1',
                tenantId: TENANT,
                actorId: ACTOR,
                occurredAt: '2026-06-25T10:00:00.000Z',
                payload: { employeeId: 'not-enough-fields' },
            })
        ).rejects.toThrow();
        expect(create).not.toHaveBeenCalled();
    });
});

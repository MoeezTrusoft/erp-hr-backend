// tests/unit/services/employeeOutbox.service.test.js
//
// A.4 — hr.employee.lifecycle.v1 outbox writer.
//
// Proves:
//   * the payload is parsed against HrEmployeeLifecycleV1 (validate-before-write),
//   * the EventEnvelope wrapping it is parsed strict (a non-conformant event
//     never reaches the DB),
//   * EventEnvelope.correlationId is the REQUEST correlation id (A.5 end-to-end),
//   * the row is written via the passed transaction client (atomicity),
//   * a contract violation THROWS (so it rolls back the surrounding tx),
//   * the model-unavailable mock path fails soft (returns null + warns).
import { describe, it, expect, jest } from '@jest/globals';

import {
    buildEmployeeLifecyclePayload,
    buildEmployeeLifecycleEnvelope,
    enqueueEmployeeLifecycle,
    HR_EMPLOYEE_LIFECYCLE_V1,
} from '../../../src/services/employeeOutbox.service.js';

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const EMP_UUID = '11111111-2222-4333-8444-555555555555';
const ORG_UNIT = '99999999-2222-4333-8444-555555555555';

const validInput = () => ({
    tenantId: TENANT,
    employeeId: EMP_UUID,
    employeeNumber: 'E-100',
    name: { given: 'Ada', family: 'Lovelace' },
    orgUnitId: ORG_UNIT,
    phase: 'hired',
    effectiveOn: '2026-06-24',
});

describe('buildEmployeeLifecyclePayload (validate-before-write)', () => {
    it('returns a HrEmployeeLifecycleV1-conformant payload', () => {
        const payload = buildEmployeeLifecyclePayload(validInput());
        expect(payload.phase).toBe('hired');
        expect(payload.employeeId).toBe(EMP_UUID);
        expect(payload.tenantId).toBe(TENANT);
    });

    it('throws when the phase is not a valid lifecycle phase', () => {
        expect(() =>
            buildEmployeeLifecyclePayload({ ...validInput(), phase: 'banana' })
        ).toThrow();
    });

    it('throws when a required id is missing', () => {
        const bad = validInput();
        delete bad.orgUnitId;
        expect(() => buildEmployeeLifecyclePayload(bad)).toThrow();
    });
});

describe('buildEmployeeLifecycleEnvelope (A.5 correlation threading)', () => {
    it('wraps the payload in a conformant EventEnvelope using the request correlationId', () => {
        const payload = buildEmployeeLifecyclePayload(validInput());
        const envelope = buildEmployeeLifecycleEnvelope({
            payload,
            tenantId: TENANT,
            actorId: '77777777-2222-4333-8444-555555555555',
            occurredAt: '2026-06-24T10:00:00.000Z',
            correlationId: 'req-correlation-42',
        });

        expect(envelope.name).toBe(HR_EMPLOYEE_LIFECYCLE_V1);
        expect(envelope.correlationId).toBe('req-correlation-42'); // NOT freshly minted
        expect(envelope.payload.phase).toBe('hired');
        expect(envelope.actor.type).toBe('service');
        // id is a uuid
        expect(envelope.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
    });

    it('mints a correlationId only when none is supplied', () => {
        const payload = buildEmployeeLifecyclePayload(validInput());
        const envelope = buildEmployeeLifecycleEnvelope({
            payload,
            tenantId: TENANT,
            actorId: '77777777-2222-4333-8444-555555555555',
            occurredAt: '2026-06-24T10:00:00.000Z',
        });
        expect(typeof envelope.correlationId).toBe('string');
        expect(envelope.correlationId.length).toBeGreaterThan(0);
    });
});

describe('enqueueEmployeeLifecycle', () => {
    it('writes a validated EventEnvelope row via the tx client', async () => {
        const create = jest.fn(async (args) => ({ id: 'outbox-1', ...args.data }));
        const tx = { outboxEvent: { create } };

        const row = await enqueueEmployeeLifecycle(tx, {
            ...validInput(),
            actorId: '77777777-2222-4333-8444-555555555555',
            occurredAt: '2026-06-24T10:00:00.000Z',
            correlationId: 'corr-row',
        });

        expect(create).toHaveBeenCalledTimes(1);
        const data = create.mock.calls[0][0].data;
        expect(data.eventName).toBe(HR_EMPLOYEE_LIFECYCLE_V1);
        expect(data.aggregateType).toBe('Employee');
        expect(data.tenantId).toBe(TENANT);
        // payload is the EventEnvelope, correlationId threaded from the request
        expect(data.payload.correlationId).toBe('corr-row');
        expect(data.payload.name).toBe(HR_EMPLOYEE_LIFECYCLE_V1);
        expect(row.id).toBe('outbox-1');
    });

    it('throws (rolls back) when the event is not contract-conformant', async () => {
        const create = jest.fn();
        const tx = { outboxEvent: { create } };

        await expect(
            enqueueEmployeeLifecycle(tx, {
                ...validInput(),
                phase: 'not-a-phase',
                actorId: '77777777-2222-4333-8444-555555555555',
            })
        ).rejects.toThrow();
        expect(create).not.toHaveBeenCalled(); // never wrote a bad event
    });

    it('fails soft (returns null) when the outbox model is unavailable', async () => {
        const row = await enqueueEmployeeLifecycle({}, {
            ...validInput(),
            actorId: '77777777-2222-4333-8444-555555555555',
        });
        expect(row).toBeNull();
    });
});

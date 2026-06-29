// tests/unit/services/employeeOutbox.map.test.js
//
// A.4 — mapping an HR Employee row (Int id, no UUID surrogate, no orgUnit UUID)
// onto the contract-required ids-only HrEmployeeLifecycleV1 input. Mirrors the
// comms BigInt→UUIDv5 bridge: required UUID ids that HR does not natively hold
// are derived DETERMINISTICALLY so the event is contract-valid AND stable
// across retries. The mapped input must satisfy buildEmployeeLifecyclePayload.
import { describe, it, expect } from '@jest/globals';

import {
    mapEmployeeToLifecycleInput,
    buildEmployeeLifecyclePayload,
} from '../../../src/services/employeeOutbox.service.js';

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';

const employeeRow = () => ({
    id: 42,
    tenant_id: TENANT,
    first_name: 'Ada',
    last_name: 'Lovelace',
    employee_code: 'E-100',
    work_email: 'ada@trusoft.pk',
    businessUnitId: 7,
    positionId: 3,
    hire_date: new Date('2026-06-24T00:00:00.000Z'),
});

describe('mapEmployeeToLifecycleInput', () => {
    it('derives contract-valid UUIDs and a CalendarDate from an Int-keyed row', () => {
        const input = mapEmployeeToLifecycleInput(employeeRow(), 'hired');

        // employeeId / orgUnitId derived as UUIDs (HR has no native surrogate)
        expect(input.employeeId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
        expect(input.orgUnitId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
        expect(input.tenantId).toBe(TENANT);
        expect(input.phase).toBe('hired');
        expect(input.effectiveOn).toBe('2026-06-24');
        expect(input.name).toEqual({ given: 'Ada', family: 'Lovelace' });

        // The mapped input is contract-conformant.
        expect(() => buildEmployeeLifecyclePayload(input)).not.toThrow();
    });

    it('is deterministic — same row + phase yields the same derived ids', () => {
        const a = mapEmployeeToLifecycleInput(employeeRow(), 'hired');
        const b = mapEmployeeToLifecycleInput(employeeRow(), 'hired');
        expect(a.employeeId).toBe(b.employeeId);
        expect(a.orgUnitId).toBe(b.orgUnitId);
    });

    it('maps terminate → terminated phase and carries the cause', () => {
        const input = mapEmployeeToLifecycleInput(employeeRow(), 'terminated', {
            terminationCause: 'resigned',
        });
        expect(input.phase).toBe('terminated');
        expect(input.terminationCause).toBe('resigned');
        expect(() => buildEmployeeLifecyclePayload(input)).not.toThrow();
    });
});

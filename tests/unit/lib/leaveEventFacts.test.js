// tests/unit/lib/leaveEventFacts.test.js: leave-event payload facts shared by
// the approval finalizer and the hrEvents.js builders.
import { describe, it, expect } from '@jest/globals';

import { toDateOnly, leaveEventFacts } from '../../../src/lib/leaveEventFacts.js';
import { leaveApprovedEvent, leaveRejectedEvent } from '../../../src/services/hrEvents.js';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';

describe('toDateOnly', () => {
    it('formats the UTC calendar day of a Date, ISO string or date string', () => {
        expect(toDateOnly(new Date('2026-09-21T00:00:00.000Z'))).toBe('2026-09-21');
        expect(toDateOnly('2026-09-21T23:59:59.000Z')).toBe('2026-09-21');
        expect(toDateOnly('2026-09-21')).toBe('2026-09-21');
    });
    it('returns null for missing or invalid values', () => {
        expect(toDateOnly(null)).toBeNull();
        expect(toDateOnly(undefined)).toBeNull();
        expect(toDateOnly('not a date')).toBeNull();
    });
});

describe('leaveEventFacts', () => {
    it('emits ids as strings, the day count and the inclusive range', () => {
        expect(leaveEventFacts({
            id: 9, leavePolicyId: 3, totalDays: 1.5,
            startDate: new Date('2026-10-01T00:00:00.000Z'), endDate: new Date('2026-10-02T00:00:00.000Z'),
        })).toEqual({
            leaveRequestId: '9', leavePolicyId: '3', totalDays: 1.5, startDate: '2026-10-01', endDate: '2026-10-02',
        });
    });
    it('is null tolerant', () => {
        expect(leaveEventFacts({})).toEqual({
            leaveRequestId: null, leavePolicyId: null, totalDays: null, startDate: null, endDate: null,
        });
    });
});

describe('hrEvents leave builders carry the date range', () => {
    const req = {
        id: 4, employeeId: 7, leavePolicyId: 2, totalDays: 2, tenantId: TENANT,
        startDate: new Date('2026-11-02T00:00:00.000Z'), endDate: new Date('2026-11-03T00:00:00.000Z'),
    };
    it.each([
        ['approved', leaveApprovedEvent],
        ['rejected', leaveRejectedEvent],
    ])('%s', (_name, build) => {
        const { payload } = build(req, {});
        expect(payload.startDate).toBe('2026-11-02');
        expect(payload.endDate).toBe('2026-11-03');
        expect(payload.leaveRequestId).toBe('4');
    });
});

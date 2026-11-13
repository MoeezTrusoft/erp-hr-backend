// tests/unit/services/hrEventBuilders.test.js
//
// M1-HR fan-out (WBS-MODULES §M1) — the per-domain event builders that map an
// HR aggregate row + acting context onto a CONTRACT-VALID EventEnvelope for the
// transactional outbox. Pure mappers (no DB) so the wiring is deterministically
// testable; the service paths call enqueueHrDomainEvent(tx, builder(...)).
//
// Proves each builder produces an enqueue-arg whose envelope passes the
// contract (validate-before-write) and carries ids-only, tenant-scoped payloads.
import { describe, it, expect } from '@jest/globals';

import { buildHrEventEnvelope } from '../../../src/services/hrDomainEvent.service.js';
import {
    leaveApprovedEvent,
    leaveRejectedEvent,
    payrollRunFinalizedEvent,
    attendanceRecordedEvent,
    candidateHiredEvent,
    offerSentEvent,
    performanceReviewFinalizedEvent,
} from '../../../src/services/hrEvents.js';

const TENANT = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const ctx = { actorId: 7, correlationId: 'corr-xyz' };

// Each builder returns an enqueueHrDomainEvent arg; buildHrEventEnvelope(arg)
// must produce a contract-valid envelope (the real validate-before-write path).
function assertValid(arg, expectedName) {
    expect(arg.eventName).toBe(expectedName);
    expect(arg.tenantId).toBe(TENANT);
    const env = buildHrEventEnvelope(arg);
    expect(env.name).toBe(expectedName);
    expect(env.tenantId).toBe(TENANT);
    expect(env.correlationId).toBe('corr-xyz');
    expect(env.actor.id).toBe('7');
    return env;
}

describe('hrEvents builders', () => {
    it('leaveApprovedEvent → hr.leave.approved.v1', () => {
        const env = assertValid(
            leaveApprovedEvent({ id: 11, employeeId: 3, leavePolicyId: 2, totalDays: 4, tenantId: TENANT }, ctx),
            'hr.leave.approved.v1'
        );
        expect(env.payload.leaveRequestId).toBe('11');
        expect(env.payload.status).toBe('APPROVED');
    });

    it('leaveRejectedEvent → hr.leave.rejected.v1', () => {
        const env = assertValid(
            leaveRejectedEvent({ id: 12, employeeId: 3, tenantId: TENANT }, ctx, { reason: 'no cover' }),
            'hr.leave.rejected.v1'
        );
        expect(env.payload.status).toBe('REJECTED');
    });

    it('payrollRunFinalizedEvent → hr.payroll.run_finalized.v1', () => {
        const env = assertValid(
            payrollRunFinalizedEvent({ id: 99, periodStart: '2026-06-01', periodEnd: '2026-06-30', employeeCount: 10, tenantId: TENANT }, ctx),
            'hr.payroll.run_finalized.v1'
        );
        expect(env.payload.runId).toBe('99');
        expect(env.payload.employeeCount).toBe(10);
    });

    // HR-PAYSLIPALERT-02 — the run_finalized event must carry the affected
    // employees' ids (string) so the notification-hub mapper can fan out a
    // "payslip ready" notification per employee (it reads payload.employeeIds[]).
    // ids-only, no PII (ARCH-01 §13).
    it('payrollRunFinalizedEvent carries employeeIds as STRINGS (HR-PAYSLIPALERT-02)', () => {
        const env = assertValid(
            payrollRunFinalizedEvent({ id: 99, periodStart: '2026-06-01', periodEnd: '2026-06-30', employeeIds: [11, 22], tenantId: TENANT }, ctx),
            'hr.payroll.run_finalized.v1'
        );
        expect(env.payload.employeeIds).toEqual(['11', '22']);
    });

    it('payrollRunFinalizedEvent defaults employeeIds to [] when absent (HR-PAYSLIPALERT-02)', () => {
        const env = assertValid(
            payrollRunFinalizedEvent({ id: 99, periodStart: '2026-06-01', periodEnd: '2026-06-30', employeeCount: 0, tenantId: TENANT }, ctx),
            'hr.payroll.run_finalized.v1'
        );
        expect(env.payload.employeeIds).toEqual([]);
    });

    it('attendanceRecordedEvent → hr.attendance.recorded.v1', () => {
        const env = assertValid(
            attendanceRecordedEvent({ id: 5, employeeId: 3, action: 'checkin', at: '2026-06-25T08:00:00.000Z', tenantId: TENANT }, ctx),
            'hr.attendance.recorded.v1'
        );
        expect(env.payload.action).toBe('checkin');
        expect(env.payload.employeeId).toBe('3');
    });

    it('candidateHiredEvent → hr.recruitment.candidate_hired.v1', () => {
        const env = assertValid(
            candidateHiredEvent({ id: 8, applicationId: 4, employeeId: 3, tenantId: TENANT }, ctx),
            'hr.recruitment.candidate_hired.v1'
        );
        expect(env.payload.candidateId).toBe('8');
    });

    it('offerSentEvent → hr.recruitment.offer_sent.v1', () => {
        const env = assertValid(
            offerSentEvent({ id: 6, candidateId: 8, tenantId: TENANT }, ctx),
            'hr.recruitment.offer_sent.v1'
        );
        expect(env.payload.offerId).toBe('6');
    });

    it('performanceReviewFinalizedEvent → hr.performance.review_finalized.v1', () => {
        const env = assertValid(
            performanceReviewFinalizedEvent({ id: 2, employeeId: 3, cycleId: 1, rating: 'EXCEEDS', tenantId: TENANT }, ctx),
            'hr.performance.review_finalized.v1'
        );
        expect(env.payload.reviewId).toBe('2');
        expect(env.payload.rating).toBe('EXCEEDS');
    });

    it('returns null when the aggregate has no tenant (fail-closed)', () => {
        expect(leaveApprovedEvent({ id: 1, employeeId: 3, tenantId: null }, ctx)).toBeNull();
        expect(payrollRunFinalizedEvent({ id: 1, tenantId: undefined }, ctx)).toBeNull();
    });
});

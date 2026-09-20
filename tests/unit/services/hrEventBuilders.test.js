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
    offerAcceptedEvent,
    offerHandoffCompletedEvent,
    offerHandoffFailedEvent,
    performanceReviewFinalizedEvent,
    requisitionSubmittedEvent,
    requisitionDecisionEvent,
    requisitionPostedEvent,
    requisitionClosedEvent,
    applicationCreatedEvent,
    applicationStageChangedEvent,
    interviewScheduledEvent,
    interviewOutcomeRecordedEvent,
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
    // Phase 11 — recruitment lifecycle events. The point of running them through
    // buildHrEventEnvelope is that the NAME GRAMMAR is proven, not just plausible:
    // the contract rejects a malformed `hr.<entity>.<action>.vN` at write time.
    it('requisitionSubmittedEvent → hr.recruitment.requisition_submitted.v1', () => {
        const env = assertValid(
            requisitionSubmittedEvent({ id: 21, title: 'Backend Engineer', requestedById: 5, tenantId: TENANT }, ctx),
            'hr.recruitment.requisition_submitted.v1',
        );
        expect(env.payload).toMatchObject({ requisitionId: '21', status: 'PENDING_APPROVAL' });
    });

    it('requisitionDecisionEvent carries the decision and its reason', () => {
        const approved = assertValid(
            requisitionDecisionEvent({ id: 21, status: 'APPROVED', tenantId: TENANT }, ctx, { decision: 'APPROVED' }),
            'hr.recruitment.requisition_decided.v1',
        );
        expect(approved.payload).toMatchObject({ decision: 'APPROVED', reason: null });

        const rejected = requisitionDecisionEvent(
            { id: 21, tenantId: TENANT },
            ctx,
            { decision: 'REJECTED', reason: 'Budget frozen', decidedById: 9 },
        );
        expect(rejected.payload).toMatchObject({ decision: 'REJECTED', reason: 'Budget frozen', decidedById: '9' });
    });

    it('requisitionPostedEvent / requisitionClosedEvent are contract-valid', () => {
        assertValid(requisitionPostedEvent({ id: 21, externalUrl: 'https://jobs.test/21', tenantId: TENANT }, ctx),
            'hr.recruitment.requisition_posted.v1');
        assertValid(requisitionClosedEvent({ id: 21, tenantId: TENANT }, ctx, { reason: 'Filled' }),
            'hr.recruitment.requisition_closed.v1');
    });

    it('applicationCreatedEvent → hr.recruitment.application_created.v1', () => {
        const env = assertValid(
            applicationCreatedEvent({ id: 31, candidateId: 8, jobRequisitionId: 21, stage: 'applied', tenantId: TENANT }, ctx),
            'hr.recruitment.application_created.v1',
        );
        expect(env.payload).toMatchObject({ applicationId: '31', candidateId: '8', stage: 'applied' });
    });

    it('applicationStageChangedEvent carries from → to and the enforced reason', () => {
        const env = assertValid(
            applicationStageChangedEvent(
                { id: 31, candidateId: 8, jobRequisitionId: 21, stage: 'rejected', status: 'active', tenantId: TENANT },
                ctx,
                { fromStage: 'screening', toStage: 'rejected', reason: 'Not a fit' },
            ),
            'hr.recruitment.application_stage_changed.v1',
        );
        expect(env.payload).toMatchObject({ fromStage: 'screening', toStage: 'rejected', reason: 'Not a fit' });
    });

    it('interviewScheduledEvent routes to interviewer ids, never names', () => {
        const env = assertValid(
            interviewScheduledEvent(
                { id: 41, applicationId: 31, candidateId: 8, scheduledAt: '2026-10-01T09:00:00.000Z', tenantId: TENANT },
                ctx,
                { interviewerIds: [3, 4] },
            ),
            'hr.recruitment.interview_scheduled.v1',
        );
        expect(env.payload.interviewerIds).toEqual(['3', '4']);
    });

    it('interviewOutcomeRecordedEvent flags an overridden outcome', () => {
        const env = assertValid(
            interviewOutcomeRecordedEvent(
                { id: 41, applicationId: 31, outcome: 'NEXT_ROUND', tenantId: TENANT },
                ctx,
                { overridden: true, reason: 'Scorecard submitted offline' },
            ),
            'hr.recruitment.interview_outcome_recorded.v1',
        );
        expect(env.payload).toMatchObject({ outcome: 'NEXT_ROUND', overridden: true });
    });

    it('a recruitment builder with no tenant returns null (fail-closed, never throws)', () => {
        expect(applicationStageChangedEvent({ id: 31 }, ctx, { toStage: 'screening' })).toBeNull();
        expect(interviewScheduledEvent({ id: 41 }, ctx)).toBeNull();
        expect(requisitionSubmittedEvent({ id: 21 }, ctx)).toBeNull();
    });

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

    it('offerAcceptedEvent → hr.recruitment.offer_accepted.v1', () => {
        const env = assertValid(
            offerAcceptedEvent({ id: 6, applicationId: 4, candidateId: 8, tenantId: TENANT }, ctx),
            'hr.recruitment.offer_accepted.v1'
        );
        expect(env.payload.offerId).toBe('6');
        expect(env.payload.applicationId).toBe('4');
    });

    it('offerHandoffCompletedEvent → hr.recruitment.handoff_completed.v1', () => {
        const env = assertValid(
            offerHandoffCompletedEvent(
                { id: 2, offerId: 6, employeeId: 3, checklistId: 9, tenantId: TENANT },
                ctx
            ),
            'hr.recruitment.handoff_completed.v1'
        );
        expect(env.payload.handoffId).toBe('2');
        expect(env.payload.employeeId).toBe('3');
        expect(env.payload.checklistId).toBe('9');
    });

    it('offerHandoffFailedEvent → hr.recruitment.handoff_failed.v1', () => {
        const env = assertValid(
            offerHandoffFailedEvent({ id: 2, offerId: 6, attemptCount: 3, tenantId: TENANT }, ctx, { step: 'provision' }),
            'hr.recruitment.handoff_failed.v1'
        );
        expect(env.payload.step).toBe('provision');
        expect(env.payload.attemptCount).toBe(3);
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

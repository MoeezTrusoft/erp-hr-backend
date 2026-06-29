// src/services/hrEvents.js — M1-HR fan-out builders (WBS-MODULES §M1).
//
// Per-domain mappers that turn an HR aggregate row + acting context into an
// `enqueueHrDomainEvent` argument (see hrDomainEvent.service.js). They are PURE
// (no DB) so the wiring is deterministically testable and the service paths
// stay thin:
//
//   await prisma.$transaction(async (tx) => {
//     const row = await tx.<aggregate>.update(...);
//     await enqueueHrDomainEvent(tx, leaveApprovedEvent(row, ctx));
//   });
//
// PAYLOADS are ids-only + a few non-PII facts (ARCH-01 §13) — consumers
// (projects capacity, notification-hub, analytics) react to identity + the
// state change, never to embedded PII. The wrapping EventEnvelope is validated
// against the contract at enqueue time (validate-before-write); these builders
// only assemble the input.
//
// FAIL-CLOSED: a builder returns null when the aggregate carries no tenant — an
// event with no tenant can never be contract-valid and must never break the
// surrounding aggregate write. enqueueHrDomainEvent also guards this, so a null
// builder result is a no-op the caller can pass straight through.

function tenantOf(row) {
    return row?.tenantId ?? row?.tenant_id ?? null;
}

function baseArgs(eventName, row, ctx, { aggregateType, aggregateId, payload }) {
    const tenantId = tenantOf(row);
    if (!tenantId) return null;
    return {
        eventName,
        tenantId,
        aggregateType,
        aggregateId,
        actorId: ctx?.actorId,
        correlationId: ctx?.correlationId,
        causationId: ctx?.causationId,
        payload,
    };
}

// ── Leave ──────────────────────────────────────────────────────────────────
export function leaveApprovedEvent(req, ctx = {}) {
    return baseArgs('hr.leave.approved.v1', req, ctx, {
        aggregateType: 'LeaveRequest',
        aggregateId: req?.id,
        payload: {
            leaveRequestId: String(req?.id),
            employeeId: req?.employeeId != null ? String(req.employeeId) : null,
            leavePolicyId: req?.leavePolicyId != null ? String(req.leavePolicyId) : null,
            totalDays: req?.totalDays ?? null,
            status: 'APPROVED',
        },
    });
}

export function leaveRejectedEvent(req, ctx = {}, extra = {}) {
    return baseArgs('hr.leave.rejected.v1', req, ctx, {
        aggregateType: 'LeaveRequest',
        aggregateId: req?.id,
        payload: {
            leaveRequestId: String(req?.id),
            employeeId: req?.employeeId != null ? String(req.employeeId) : null,
            status: 'REJECTED',
            reason: extra?.reason ?? null,
        },
    });
}

// ── Payroll ──────────────────────────────────────────────────────────────────
export function payrollRunFinalizedEvent(run, ctx = {}) {
    return baseArgs('hr.payroll.run_finalized.v1', run, ctx, {
        aggregateType: 'PayrollRun',
        aggregateId: run?.id,
        payload: {
            runId: String(run?.id),
            periodStart: run?.periodStart ?? null,
            periodEnd: run?.periodEnd ?? null,
            employeeCount: run?.employeeCount ?? null,
            // HR-PAYSLIPALERT-02: ids-only recipient list the notification-hub
            // mapper fans out a "payslip ready" notification across. Stringified
            // + default [] (tolerant) — no PII (ARCH-01 §13).
            employeeIds: (run?.employeeIds ?? []).map(String),
        },
    });
}

// ── Attendance ───────────────────────────────────────────────────────────────
export function attendanceRecordedEvent(att, ctx = {}) {
    return baseArgs('hr.attendance.recorded.v1', att, ctx, {
        aggregateType: 'Attendance',
        aggregateId: att?.id,
        payload: {
            attendanceId: att?.id != null ? String(att.id) : null,
            employeeId: att?.employeeId != null ? String(att.employeeId) : null,
            action: att?.action ?? null,
            at: att?.at ?? null,
        },
    });
}

// ── Recruitment ──────────────────────────────────────────────────────────────
export function candidateHiredEvent(candidate, ctx = {}) {
    return baseArgs('hr.recruitment.candidate_hired.v1', candidate, ctx, {
        aggregateType: 'Candidate',
        aggregateId: candidate?.id,
        payload: {
            candidateId: String(candidate?.id),
            applicationId: candidate?.applicationId != null ? String(candidate.applicationId) : null,
            employeeId: candidate?.employeeId != null ? String(candidate.employeeId) : null,
        },
    });
}

export function offerSentEvent(offer, ctx = {}) {
    return baseArgs('hr.recruitment.offer_sent.v1', offer, ctx, {
        aggregateType: 'Offer',
        aggregateId: offer?.id,
        payload: {
            offerId: String(offer?.id),
            candidateId: offer?.candidateId != null ? String(offer.candidateId) : null,
        },
    });
}

// ── Performance ──────────────────────────────────────────────────────────────
export function performanceReviewFinalizedEvent(review, ctx = {}) {
    return baseArgs('hr.performance.review_finalized.v1', review, ctx, {
        aggregateType: 'PerformanceReview',
        aggregateId: review?.id,
        payload: {
            reviewId: String(review?.id),
            employeeId: review?.employeeId != null ? String(review.employeeId) : null,
            cycleId: review?.cycleId != null ? String(review.cycleId) : null,
            rating: review?.rating ?? null,
        },
    });
}

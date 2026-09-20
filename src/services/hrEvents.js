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

// HR-PAYSLIP-QN: an employee raised a question against their own payslip from
// the My-Payslip self-service screen. ids-only payload (no PII) so downstream
// consumers (notification-hub → notify payroll admins) react to the identity +
// the state change. Null-tolerant + string-ified ids like the other builders.
export function payslipQuestionRaisedEvent(question, ctx = {}) {
    return baseArgs('hr.payslip.question_raised.v1', question, ctx, {
        aggregateType: 'PayslipQuestion',
        aggregateId: question?.id,
        payload: {
            payslipQuestionId: question?.id != null ? String(question.id) : null,
            payslipId: question?.payslipId != null ? String(question.payslipId) : null,
            employeeId: question?.employeeId != null ? String(question.employeeId) : null,
            question: question?.question ?? null,
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

// Phase 9 — the candidate answered a sent offer. ids-only (no PII, no salary):
// downstream consumers react to the decision, never to compensation.
export function offerAcceptedEvent(offer, ctx = {}) {
    return baseArgs('hr.recruitment.offer_accepted.v1', offer, ctx, {
        aggregateType: 'Offer',
        aggregateId: offer?.id,
        payload: {
            offerId: String(offer?.id),
            applicationId: offer?.applicationId != null ? String(offer.applicationId) : null,
            candidateId: offer?.candidateId != null ? String(offer.candidateId) : null,
        },
    });
}

// Phase 9 — the accepted-offer handoff finished: one employee + checklist exist.
export function offerHandoffCompletedEvent(handoff, ctx = {}) {
    return baseArgs('hr.recruitment.handoff_completed.v1', handoff, ctx, {
        aggregateType: 'OfferHandoff',
        aggregateId: handoff?.id,
        payload: {
            handoffId: String(handoff?.id),
            offerId: handoff?.offerId != null ? String(handoff.offerId) : null,
            employeeId: handoff?.employeeId != null ? String(handoff.employeeId) : null,
            checklistId: handoff?.checklistId != null ? String(handoff.checklistId) : null,
        },
    });
}

// Phase 9 — the handoff failed and was rolled back. The failure DETAIL stays in
// offer_handoffs.lastError; the event carries only ids + the failing step so an
// operator can be alerted without leaking a database error into the fabric.
export function offerHandoffFailedEvent(handoff, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.handoff_failed.v1', handoff, ctx, {
        aggregateType: 'OfferHandoff',
        aggregateId: handoff?.id,
        payload: {
            handoffId: String(handoff?.id),
            offerId: handoff?.offerId != null ? String(handoff.offerId) : null,
            step: extra?.step ?? null,
            attemptCount: handoff?.attemptCount ?? null,
        },
    });
}

// Phase 11 — requisition lifecycle. Payloads carry the state fact + the ids a
// consumer needs to route (approvers, recruiters); no compensation, no PII.
export function requisitionSubmittedEvent(requisition, ctx = {}) {
    return baseArgs('hr.recruitment.requisition_submitted.v1', requisition, ctx, {
        aggregateType: 'JobRequisition',
        aggregateId: requisition?.id,
        payload: {
            requisitionId: String(requisition?.id),
            status: 'PENDING_APPROVAL',
            title: requisition?.title ?? null,
            departmentId: requisition?.departmentId != null ? String(requisition.departmentId) : null,
            requestedById: requisition?.requestedById != null ? String(requisition.requestedById) : null,
        },
    });
}

// A decision on a submitted requisition. `APPROVED` and `REJECTED` are the same
// fact from the fabric's point of view (a decision was taken), so one builder
// carries the outcome rather than two near-identical names consumers must both
// subscribe to.
export function requisitionDecisionEvent(requisition, ctx = {}, extra = {}) {
    const decision = String(extra?.decision ?? requisition?.status ?? '').toUpperCase();
    return baseArgs('hr.recruitment.requisition_decided.v1', requisition, ctx, {
        aggregateType: 'JobRequisition',
        aggregateId: requisition?.id,
        payload: {
            requisitionId: String(requisition?.id),
            decision: decision === 'REJECTED' ? 'REJECTED' : 'APPROVED',
            // A rejection must carry why; the reason is the operator's own text
            // (compliance-relevant), not candidate data.
            reason: extra?.reason ?? null,
            decidedById: extra?.decidedById != null ? String(extra.decidedById) : null,
        },
    });
}

// The requisition became visible to candidates (or stopped being).
export function requisitionPostedEvent(requisition, ctx = {}) {
    return baseArgs('hr.recruitment.requisition_posted.v1', requisition, ctx, {
        aggregateType: 'JobRequisition',
        aggregateId: requisition?.id,
        payload: {
            requisitionId: String(requisition?.id),
            status: 'POSTED',
            externalUrl: requisition?.externalUrl ?? null,
        },
    });
}

export function requisitionClosedEvent(requisition, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.requisition_closed.v1', requisition, ctx, {
        aggregateType: 'JobRequisition',
        aggregateId: requisition?.id,
        payload: {
            requisitionId: String(requisition?.id),
            status: 'CLOSED',
            reason: extra?.reason ?? null,
        },
    });
}

// Phase 11 — application lifecycle. A stage change is the event recruiters and
// hiring managers actually want ("moved to interview"), so `from`/`to` travel
// with the ids and the optional reason that the workflow already enforces.
export function applicationCreatedEvent(application, ctx = {}) {
    return baseArgs('hr.recruitment.application_created.v1', application, ctx, {
        aggregateType: 'Application',
        aggregateId: application?.id,
        payload: {
            applicationId: String(application?.id),
            candidateId: application?.candidateId != null ? String(application.candidateId) : null,
            jobRequisitionId: application?.jobRequisitionId != null ? String(application.jobRequisitionId) : null,
            stage: application?.stage ?? null,
        },
    });
}

export function applicationStageChangedEvent(application, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.application_stage_changed.v1', application, ctx, {
        aggregateType: 'Application',
        aggregateId: application?.id,
        payload: {
            applicationId: String(application?.id),
            candidateId: application?.candidateId != null ? String(application.candidateId) : null,
            jobRequisitionId: application?.jobRequisitionId != null ? String(application.jobRequisitionId) : null,
            fromStage: extra?.fromStage ?? null,
            toStage: extra?.toStage ?? application?.stage ?? null,
            status: application?.status ?? null,
            reason: extra?.reason ?? null,
        },
    });
}

// Phase 11 — interview scheduled + outcome. `interviewerIds` is the routing list
// a notification consumer fans out over (ids-only, no names/emails).
export function interviewScheduledEvent(interview, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.interview_scheduled.v1', interview, ctx, {
        aggregateType: 'Interview',
        aggregateId: interview?.id,
        payload: {
            interviewId: String(interview?.id),
            applicationId: interview?.applicationId != null ? String(interview.applicationId) : null,
            candidateId: interview?.candidateId != null ? String(interview.candidateId) : null,
            scheduledAt: interview?.scheduledAt ?? null,
            interviewerIds: (extra?.interviewerIds ?? interview?.interviewerIds ?? []).map(String),
        },
    });
}

export function interviewOutcomeRecordedEvent(interview, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.interview_outcome_recorded.v1', interview, ctx, {
        aggregateType: 'Interview',
        aggregateId: interview?.id,
        payload: {
            interviewId: String(interview?.id),
            applicationId: interview?.applicationId != null ? String(interview.applicationId) : null,
            outcome: interview?.outcome ?? extra?.outcome ?? null,
            // Whether the outcome rode an override rather than evidence — the
            // fabric should show that a human overrode the gate.
            overridden: Boolean(extra?.overridden),
            reason: extra?.reason ?? null,
        },
    });
}

// ── Documents (compliance / expiry) ──────────────────────────────────────────
// HR Reports → Document Expiry Alerts: a manually-sent reminder for an
// employee's about-to-expire (or expired) document. HR only EMITS this event;
// the actual in-app notification is produced DOWNSTREAM by notification-hub if
// it has a mapper for `hr.document.expiry_reminder.v1`. The email channel is
// intentionally disabled at the source (see EMAIL_ENABLED in
// documentExpiryReport.service.js); channels.email is threaded through as false
// so a downstream mapper never fans an email out until it is flipped on.
export function documentExpiryReminderEvent(media, ctx = {}, extra = {}) {
    // The EmployeeMedia row carries snake_case ids/fields; tolerate nulls and
    // string-ify every id (baseArgs pulls tenantId off the row, fail-closed).
    const documentName =
        media?.file_name || media?.title || 'Document';
    return baseArgs('hr.document.expiry_reminder.v1', media, ctx, {
        aggregateType: 'EmployeeMedia',
        aggregateId: media?.id,
        payload: {
            employeeMediaId: media?.id != null ? String(media.id) : null,
            employeeId: media?.employee_id != null ? String(media.employee_id) : null,
            documentName,
            expiryDate: media?.expiry_date ?? null,
            message: extra?.message ?? null,
            // email channel intentionally disabled — flip EMAIL_ENABLED /
            // notification-hub mapper when ready.
            channels: { inApp: true, email: extra?.emailEnabled === true },
        },
    });
}

// ── Onboarding ───────────────────────────────────────────────────────────────
// FE Onboarding Portal → "Send reminder". HR only EMITS this; notification-hub
// produces the in-app notification downstream if it maps `hr.onboarding.task_reminder.v1`.
// The responsible employee (task assignee) is the recipient. Email channel is
// intentionally disabled at the source until the mapper is flipped on.
export function onboardingTaskReminderEvent(task, ctx = {}, extra = {}) {
    // `task` carries the row's tenantId (baseArgs pulls it, fail-closed).
    return baseArgs('hr.onboarding.task_reminder.v1', task, ctx, {
        aggregateType: 'OnboardingTask',
        aggregateId: task?.id,
        payload: {
            taskId: task?.id != null ? String(task.id) : null,
            checklistId: task?.checklistId != null ? String(task.checklistId) : null,
            employeeId: extra?.employeeId != null ? String(extra.employeeId) : null,
            // the responsible employee the reminder is addressed to
            recipientId: extra?.recipientId != null ? String(extra.recipientId) : null,
            subject: extra?.subject ?? null,
            message: extra?.message ?? null,
            dueDate: task?.dueDate ?? null,
            channels: { inApp: true, email: extra?.emailEnabled === true },
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

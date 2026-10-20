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
// Phase 11 residue — `createdById` (the recruiter who owns the offer) is now
// carried so the hub can route an internal "offer accepted" notice; a candidate
// is not a platform user, so without it there is no routable recipient and the
// mapper skips (the previous reason this name was deliberately unmapped).
export function offerAcceptedEvent(offer, ctx = {}) {
    return baseArgs('hr.recruitment.offer_accepted.v1', offer, ctx, {
        aggregateType: 'Offer',
        aggregateId: offer?.id,
        payload: {
            offerId: String(offer?.id),
            applicationId: offer?.applicationId != null ? String(offer.applicationId) : null,
            candidateId: offer?.candidateId != null ? String(offer.candidateId) : null,
            createdById: offer?.createdById != null ? String(offer.createdById) : null,
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
// Phase 11 residue — `createdById` rides along as the OPERATOR routing id: the
// offer's owning recruiter is the person who must chase provisioning, and the
// handoff's hire is exactly who a failure notice must NOT be addressed to.
export function offerHandoffFailedEvent(handoff, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.handoff_failed.v1', handoff, ctx, {
        aggregateType: 'OfferHandoff',
        aggregateId: handoff?.id,
        payload: {
            handoffId: String(handoff?.id),
            offerId: handoff?.offerId != null ? String(handoff.offerId) : null,
            step: extra?.step ?? null,
            attemptCount: handoff?.attemptCount ?? null,
            operatorId: extra?.operatorId ?? (handoff?.offer?.createdById != null ? String(handoff.offer.createdById) : null),
        },
    });
}

// Phase 11 — requisition lifecycle. Payloads carry the state fact + the ids a
// consumer needs to route (approvers, recruiters); no compensation, no PII.
export function requisitionSubmittedEvent(requisition, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.requisition_submitted.v1', requisition, ctx, {
        aggregateType: 'JobRequisition',
        aggregateId: requisition?.id,
        payload: {
            requisitionId: String(requisition?.id),
            status: 'PENDING_APPROVAL',
            title: requisition?.title ?? null,
            departmentId: requisition?.departmentId != null ? String(requisition.departmentId) : null,
            requestedById: requisition?.requestedById != null ? String(requisition.requestedById) : null,
            // Phase 4 shipped the approval chain, so the event now carries the
            // FIRST PENDING step's resolved approver — the recipient the hub
            // maps this event to. Null when the chain is un-stepped (a tenant
            // with no configured rules: the single decision needs no routing),
            // or when the first step names a role with no pinned approver (the
            // tenant routes those decisions through its own directory lookup).
            // ids-only, same convention as requestedById.
            pendingApproverId:
                extra?.pendingApproverId != null ? String(extra.pendingApproverId) : null,
            // The step the routing id was resolved for, so a consumer can show
            // or log WHICH decision is awaited (e.g. 2 = HR Manager).
            pendingStepOrder: extra?.pendingStepOrder != null ? Number(extra.pendingStepOrder) : null,
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
            // Phase 11 — the ROUTING id: the requester is the person who must be
            // told the decision, and without it a notification consumer has a
            // recipient-less event it can only skip (ids-only, no PII).
            requestedById: requisition?.requestedById != null ? String(requisition.requestedById) : null,
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
            // Phase 11 — routing id (see requisitionDecisionEvent).
            requestedById: requisition?.requestedById != null ? String(requisition.requestedById) : null,
        },
    });
}

// Phase 4 — the `status` is 'CLOSED' by default but can be overridden with
// 'WITHDRAWN'. A withdrawal is a closure from the consumer's point of view (the
// same audience learns the same fact), so it reuses this event rather than adding
// a name the hub would have no mapper for — but the payload still states which of
// the two happened, so analytics does not have to infer it.
export function requisitionClosedEvent(requisition, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.requisition_closed.v1', requisition, ctx, {
        aggregateType: 'JobRequisition',
        aggregateId: requisition?.id,
        payload: {
            requisitionId: String(requisition?.id),
            status: extra?.status === 'WITHDRAWN' ? 'WITHDRAWN' : 'CLOSED',
            reason: extra?.reason ?? null,
            // Phase 11 — routing id (see requisitionDecisionEvent).
            requestedById: requisition?.requestedById != null ? String(requisition.requestedById) : null,
        },
    });
}

const isoOrNull = (value) => {
    if (value == null) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// F-04 — the requisition's application window (closesAt) passed and the expiry
// sweep closed every active posting with reason EXPIRED. The requisition STATUS
// is deliberately unchanged (it stays POSTED until a recruiter closes it), so
// this is not requisition_closed: the audience learns "no channel is live any
// more", not "the search is over". ids-only.
export function requisitionPostingsExpiredEvent(requisition, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.postings_expired.v1', requisition, ctx, {
        aggregateType: 'JobRequisition',
        aggregateId: requisition?.id,
        payload: {
            requisitionId: String(requisition?.id),
            channels: Array.isArray(extra?.channels) ? [...extra.channels] : [],
            closesAt: isoOrNull(requisition?.closesAt),
            // Routing id (see requisitionDecisionEvent).
            requestedById: requisition?.requestedById != null ? String(requisition.requestedById) : null,
        },
    });
}

// F-02 — approval SLA. A REQUISITION/OFFER approval request has sat in one
// Approval Centre stage past its SLA. The payload is ids + timing facts only:
// the stage owner is routed by code (the line manager's code is on the request;
// HR and MANAGEMENT are permission-resolved roles, so the hub routes those by
// role and stageOwnerCode is null). `aggregateId` is the caller's dedupe key
// (request:version:stage:kind) — the sweep's idempotency lives on it.
function approvalSlaPayload(request, extra = {}) {
    return {
        approvalRef: String(request?.id),
        kind: request?.kind ?? null,
        sourceRef: request?.sourceRef != null ? String(request.sourceRef) : null,
        stage: request?.stage ?? null,
        round: request?.round ?? null,
        version: request?.version ?? null,
        stageEnteredAt: isoOrNull(extra?.stageEnteredAt),
        hoursInStage: extra?.hoursInStage ?? null,
        slaHours: extra?.slaHours ?? null,
        initiatorCode: request?.employeeCode ?? null,
        managerCode: request?.managerCode ?? null,
        stageOwnerCode: request?.stage === 'LINE_MANAGER' ? request?.managerCode ?? null : null,
    };
}

export function recruitmentApprovalReminderEvent(request, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.approval_reminder.v1', request, ctx, {
        aggregateType: 'HrApprovalRequest',
        aggregateId: extra?.aggregateId ?? request?.id,
        payload: approvalSlaPayload(request, extra),
    });
}

// Escalation goes to the role ABOVE the stalled stage (the line manager's stall
// is HR's to chase; HR's is management's; management escalates within itself).
const ESCALATE_TO_ROLE = Object.freeze({ LINE_MANAGER: 'HR', HR: 'MANAGEMENT', MANAGEMENT: 'MANAGEMENT' });

export function recruitmentApprovalEscalatedEvent(request, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.approval_escalated.v1', request, ctx, {
        aggregateType: 'HrApprovalRequest',
        aggregateId: extra?.aggregateId ?? request?.id,
        payload: {
            ...approvalSlaPayload(request, extra),
            escalateToRole: ESCALATE_TO_ROLE[request?.stage] ?? 'MANAGEMENT',
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
            // Phase 11 — routing id: the hiring manager who owns the requisition
            // is who wants "a new applicant arrived". It is read off the already-
            // included relation when the caller loaded it, and stays null (never
            // invented) when it did not.
            requestedById:
                application?.jobRequisition?.requestedById != null
                    ? String(application.jobRequisition.requestedById)
                    : null,
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
            // Phase 11 — routing id (see applicationCreatedEvent).
            requestedById:
                application?.jobRequisition?.requestedById != null
                    ? String(application.jobRequisition.requestedById)
                    : null,
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
            // Phase 11 — the panel learns its own outcome. Same routing list as
            // interviewScheduledEvent, so a consumer fans out over one field name.
            interviewerIds: (extra?.interviewerIds ?? interview?.interviewerIds ?? []).map(String),
        },
    });
}

// Phase 7 / §5.4 — an interview was CANCELLED with a coded reason. ids-only;
// the candidate-facing copy is the consumer's job.
export function interviewCancelledEvent(interview, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.interview_cancelled.v1', interview, ctx, {
        aggregateType: 'Interview',
        aggregateId: interview?.id,
        payload: {
            interviewId: String(interview?.id),
            applicationId: interview?.applicationId != null ? String(interview.applicationId) : null,
            candidateId: interview?.candidateId != null ? String(interview.candidateId) : null,
            scheduledAt: interview?.scheduledAt ?? null,
            reasonCode: extra?.reasonCode ?? null,
            interviewerIds: (extra?.interviewerIds ?? interview?.interviewerIds ?? []).map(String),
        },
    });
}

// Phase 7 / §5.3a — the replacement schedule is CONFIRMED; the panel may now be
// notified (the point of the two-phase §5.3a contract is to avoid calendar
// churn, so the panel event fires exactly once, on confirmation).
export function interviewRescheduledEvent(interview, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.interview_rescheduled.v1', interview, ctx, {
        aggregateType: 'Interview',
        aggregateId: interview?.id,
        payload: {
            interviewId: String(interview?.id),
            applicationId: interview?.applicationId != null ? String(interview.applicationId) : null,
            candidateId: interview?.candidateId != null ? String(interview.candidateId) : null,
            previousScheduledAt: extra?.previousScheduledAt ?? null,
            newScheduledAt: interview?.scheduledAt ?? extra?.newScheduledAt ?? null,
            reasonCode: extra?.reasonCode ?? null,
            interviewerIds: (extra?.interviewerIds ?? interview?.interviewerIds ?? []).map(String),
        },
    });
}

// Phase 7 / §5.3 — a candidate REQUESTED a reschedule. The recruiter is the
// audience; the panel is deliberately NOT told (§5.3a: only after the
// replacement schedule is confirmed). interviewerIds is absent on purpose —
// its presence would invite a consumer to fan out to the panel.
export function interviewRescheduleRequestedEvent(interview, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.interview_reschedule_requested.v1', interview, ctx, {
        aggregateType: 'Interview',
        aggregateId: interview?.id,
        payload: {
            interviewId: String(interview?.id),
            applicationId: interview?.applicationId != null ? String(interview.applicationId) : null,
            candidateId: interview?.candidateId != null ? String(interview.candidateId) : null,
            scheduledAt: interview?.scheduledAt ?? null,
            requestedFor: extra?.requestedFor ?? null,
            note: extra?.note ?? null,
            // §5.3 — the routing id: the REQUISITION OWNER (the recruiter who
            // owns the confirmation). ids-only, no names/addresses.
            recruiterId: extra?.recruiterId ?? null,
        },
    });
}

// ── F-37 realtime — recruitment write fan-out ────────────────────────────────
// Every recruitment WRITE the frontend performs announces itself in the same
// transaction, so the gateway SSE stream can refresh other recruiters' screens.
// Payloads are ids + state facts only: no names, no contact data, no salary.
const idStr = (value) => (value != null ? String(value) : null);
const isoStr = (value) => {
    if (value == null) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// An interview edit that is not a cancel, reschedule or outcome. `changedFields`
// carries column NAMES only (never the values), so a consumer knows what to
// re-read without the fabric carrying free-text notes.
export function interviewUpdatedEvent(interview, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.interview_updated.v1', interview, ctx, {
        aggregateType: 'Interview',
        aggregateId: interview?.id,
        payload: {
            interviewId: String(interview?.id),
            applicationId: idStr(interview?.applicationId),
            candidateId: idStr(interview?.candidateId),
            status: interview?.status ?? null,
            scheduledAt: isoStr(interview?.scheduledAt),
            decision: interview?.decision ?? null,
            changedFields: Array.isArray(extra?.changedFields) ? extra.changedFields.map(String) : [],
            interviewerIds: (extra?.interviewerIds ?? interview?.interviewerIds ?? []).map(String),
        },
    });
}

// Offer payloads never carry compensation: identity, status and the aggregate
// version (so a consumer can tell a stale refresh from a fresh one).
const offerPayload = (offer) => ({
    offerId: String(offer?.id),
    applicationId: idStr(offer?.applicationId),
    candidateId: idStr(offer?.candidateId),
    jobRequisitionId: idStr(offer?.jobRequisitionId),
    status: offer?.status ?? null,
    version: offer?.version ?? null,
});

export function offerCreatedEvent(offer, ctx = {}) {
    return baseArgs('hr.recruitment.offer_created.v1', offer, ctx, {
        aggregateType: 'Offer',
        aggregateId: offer?.id,
        payload: { ...offerPayload(offer), createdById: idStr(offer?.createdById) },
    });
}

export function offerUpdatedEvent(offer, ctx = {}) {
    return baseArgs('hr.recruitment.offer_updated.v1', offer, ctx, {
        aggregateType: 'Offer',
        aggregateId: offer?.id,
        payload: offerPayload(offer),
    });
}

// `createdById` is the routing id (the owning recruiter), as on offer_accepted.
export function offerWithdrawnEvent(offer, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.offer_withdrawn.v1', offer, ctx, {
        aggregateType: 'Offer',
        aggregateId: offer?.id,
        payload: {
            ...offerPayload(offer),
            status: 'WITHDRAWN',
            previousStatus: extra?.previousStatus ?? null,
            createdById: idStr(offer?.createdById),
        },
    });
}

export function requisitionCreatedEvent(requisition, ctx = {}) {
    return baseArgs('hr.recruitment.requisition_created.v1', requisition, ctx, {
        aggregateType: 'JobRequisition',
        aggregateId: requisition?.id,
        payload: {
            requisitionId: String(requisition?.id),
            status: requisition?.status ?? 'DRAFT',
            departmentId: idStr(requisition?.departmentId),
            positionId: idStr(requisition?.positionId),
            requestedById: idStr(requisition?.requestedById),
        },
    });
}

export function talentPoolAddedEvent(entry, ctx = {}) {
    return baseArgs('hr.recruitment.talent_pool_added.v1', entry, ctx, {
        aggregateType: 'TalentPool',
        aggregateId: entry?.id,
        payload: {
            talentPoolEntryId: String(entry?.id),
            candidateId: idStr(entry?.candidateId),
            addedById: idStr(entry?.addedById),
        },
    });
}

export function talentPoolRemovedEvent(entry, ctx = {}) {
    return baseArgs('hr.recruitment.talent_pool_removed.v1', entry, ctx, {
        aggregateType: 'TalentPool',
        aggregateId: entry?.id,
        payload: {
            talentPoolEntryId: String(entry?.id),
            candidateId: idStr(entry?.candidateId),
        },
    });
}

// `reused` is true when an open invitation already existed and this call only
// re-stamped the pool notes: the screen still changed, but nothing new was sent.
export function talentPoolInvitationSentEvent(invitation, ctx = {}, extra = {}) {
    return baseArgs('hr.recruitment.talent_pool_invitation_sent.v1', invitation, ctx, {
        aggregateType: 'TalentPoolInvitation',
        aggregateId: invitation?.id,
        payload: {
            invitationId: String(invitation?.id),
            candidateId: idStr(invitation?.candidateId),
            jobRequisitionId: idStr(invitation?.jobRequisitionId),
            status: invitation?.status ?? null,
            expiresAt: isoStr(invitation?.expiresAt),
            invitedById: idStr(invitation?.invitedById),
            reused: Boolean(extra?.reused),
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

// F-37 realtime — onboarding write fan-out. ids + state facts only; a survey
// event never carries the employee's responses.
export function onboardingChecklistCreatedEvent(checklist, ctx = {}) {
    return baseArgs('hr.onboarding.checklist_created.v1', checklist, ctx, {
        aggregateType: 'OnboardingChecklist',
        aggregateId: checklist?.id,
        payload: {
            checklistId: String(checklist?.id),
            employeeId: idStr(checklist?.employeeId),
            status: checklist?.status ?? null,
        },
    });
}

export function onboardingChecklistUpdatedEvent(checklist, ctx = {}, extra = {}) {
    return baseArgs('hr.onboarding.checklist_updated.v1', checklist, ctx, {
        aggregateType: 'OnboardingChecklist',
        aggregateId: checklist?.id,
        payload: {
            checklistId: String(checklist?.id),
            employeeId: idStr(checklist?.employeeId),
            status: checklist?.status ?? null,
            changedFields: Array.isArray(extra?.changedFields) ? extra.changedFields.map(String) : [],
        },
    });
}

const onboardingTaskPayload = (task) => ({
    taskId: String(task?.id),
    checklistId: idStr(task?.checklistId),
    assigneeId: idStr(task?.assigneeId),
    completed: Boolean(task?.completed),
    status: task?.completed ? 'COMPLETED' : 'PENDING',
});

export function onboardingTaskAddedEvent(task, ctx = {}) {
    return baseArgs('hr.onboarding.task_added.v1', task, ctx, {
        aggregateType: 'OnboardingTask',
        aggregateId: task?.id,
        payload: onboardingTaskPayload(task),
    });
}

export function onboardingTaskUpdatedEvent(task, ctx = {}) {
    return baseArgs('hr.onboarding.task_updated.v1', task, ctx, {
        aggregateType: 'OnboardingTask',
        aggregateId: task?.id,
        payload: onboardingTaskPayload(task),
    });
}

export function onboardingTaskDeletedEvent(task, ctx = {}) {
    return baseArgs('hr.onboarding.task_deleted.v1', task, ctx, {
        aggregateType: 'OnboardingTask',
        aggregateId: task?.id,
        payload: { taskId: String(task?.id), checklistId: idStr(task?.checklistId) },
    });
}

export function onboardingBuddyAssignedEvent(buddy, ctx = {}) {
    return baseArgs('hr.onboarding.buddy_assigned.v1', buddy, ctx, {
        aggregateType: 'OnboardingBuddy',
        aggregateId: buddy?.id,
        payload: {
            buddyAssignmentId: String(buddy?.id),
            checklistId: idStr(buddy?.checklistId),
            buddyId: idStr(buddy?.buddyId),
        },
    });
}

export function onboardingSurveySubmittedEvent(survey, ctx = {}) {
    return baseArgs('hr.onboarding.survey_submitted.v1', survey, ctx, {
        aggregateType: 'OnboardingSurvey',
        aggregateId: survey?.id,
        payload: {
            surveyId: String(survey?.id),
            checklistId: idStr(survey?.checklistId),
            employeeId: idStr(survey?.employeeId),
            surveyType: survey?.type ?? null,
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

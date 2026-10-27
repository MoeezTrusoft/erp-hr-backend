// src/release/recruitment-events.manifest.js
//
// Recruitment Phase 6 (go-live, plan 13.1) — the NOTIFICATION HUB MAPPING for
// every hr.recruitment.* and hr.onboarding.* event this service emits, plus
// the hub templates it sends directly (not through an event).
//
// Why it lives here: the Notification Hub (another repository) consumes
// hr:events and decides who hears about what. Each phase's notes listed "hub
// mappings needed" by hand; this file is the one list the hub owner loads.
// Pure data, no imports.
//
// MACHINE-CHECKED by tests/unit/release/recruitment-events-manifest.test.js:
//   * it scans src/ for every event name literal (hr.<domain>.<name>.v1) and
//     for the assessment builder's names (assessmentEvent("<name>", ...)), and
//     fails on an emitted name with no entry here, or an entry nothing emits;
//   * a payload key named by a recipient must appear in a file that builds
//     the event;
//   * candidate-facing routes must match the candidate-communication
//     catalogue (src/services/candidate-communication.templates.js) both ways;
//   * every non-event hub template literal in src/ is listed below or is a
//     known non-template key.
//
// Each event is either
//   notify(route, ...)            one or more routes, or
//   silent(reason)                no notification (audit, realtime refresh, or
//                                 another event carries the message), with why.
// A route is { recipient, channel, template, candidateFacing } plus optional
// `when` (the payload condition the route applies to), `mode` ("first", the
// default: the first recipient that resolves; "all": every one) and
// `pending` (the template is not built yet: an open item, with why).
//
// Recipient tokens, in order:
//   field:<key>          an employee id carried in the payload (an array of ids
//                        notifies each; a *Code key carries an employee code)
//   resolve:<key>.<attr> the hub resolves the employee from the id in
//                        payload.<key> through an HR read (e.g. the
//                        requisition's recruiterId)
//   role:<ROLE>          every holder of that role (src/release/
//                        recruitment-tools.manifest.js RECRUITMENT_ROLE_GRANTS)
//   approvalRole:<key>   holders of the Approval Centre key for the stage named
//                        by payload.<key> (LINE_MANAGER, HR, MANAGEMENT)
//   candidate            the candidate, ONLY through the candidate-communication
//                        module (its DNC, consent and rejection-delay gates);
//                        the hub never mails a candidate from an event itself
// A recipient that resolves to nobody (a null id) is dropped and logged, never
// redirected to someone the payload did not name.
//
// Channels: "in-app", "email", "in-app+email". Staff templates follow the event
// name without the version (hr.recruitment.<name>) unless a note said otherwise.
//
// HOW TO ADD AN EVENT (the lead, from a stream's note section 5):
//   add `"<event name>": notify(staff([...], "<template>"))` (or candidate(...),
//   or silent("<why>")) in its domain block below; run the events test.

const staff = (recipient, template, options = {}) =>
    Object.freeze({
        recipient: Object.freeze(recipient),
        channel: options.channel ?? "in-app",
        template,
        candidateFacing: false,
        mode: options.mode ?? "first",
        ...(options.when ? { when: options.when } : {}),
        ...(options.pending ? { pending: options.pending } : {}),
    });

// A candidate message: delivered by the candidate-communication module from
// its catalogue template (hubTemplateId), by email.
const candidate = (template, options = {}) =>
    Object.freeze({
        recipient: Object.freeze(["candidate"]),
        channel: "email",
        template,
        candidateFacing: true,
        mode: "first",
        ...(options.when ? { when: options.when } : {}),
        ...(options.pending ? { pending: options.pending } : {}),
    });

const notify = (...routes) => Object.freeze({ notify: true, routes: Object.freeze(routes) });
const silent = (reason) => Object.freeze({ notify: false, reason });

const T = (name) => `hr.recruitment.${name}`;
const O = (name) => `hr.onboarding.${name}`;

/** Event name -> notify(...) | silent(reason). */
export const RECRUITMENT_EVENT_MANIFEST = Object.freeze({
    // ── Requisitions and approvals ─────────────────────────────────────────
    "hr.recruitment.requisition_created.v1": silent("Drafting is the requester's own action; realtime refresh only"),
    "hr.recruitment.requisition_submitted.v1": notify(staff(["field:pendingApproverId"], T("requisition_submitted"))),
    "hr.recruitment.requisition_decided.v1": notify(staff(["field:requestedById"], T("requisition_decided"))),
    "hr.recruitment.requisition_posted.v1": notify(staff(["field:requestedById"], T("requisition_posted"))),
    "hr.recruitment.requisition_closed.v1": notify(
        candidate(T("candidate_position_closed"), { when: "each open application on the requisition (the module resolves them)" }),
    ),
    "hr.recruitment.postings_expired.v1": notify(staff(["field:requestedById"], T("postings_expired"))),
    // Approval SLA (flag approvalSla): the stage owner, else the Approval
    // Centre holders of that stage; escalation goes to the next stage's holders.
    "hr.recruitment.approval_reminder.v1": notify(
        staff(["field:stageOwnerCode", "approvalRole:stage"], T("approval_reminder"), { channel: "in-app+email" }),
    ),
    "hr.recruitment.approval_escalated.v1": notify(
        staff(["approvalRole:escalateToRole"], T("approval_escalated"), { channel: "in-app+email", mode: "all" }),
    ),

    // ── Applications, screening and dispositions ───────────────────────────
    "hr.recruitment.application_created.v1": notify(
        candidate(T("candidate_application_received"), { when: "not a portal intake or an accepted nurture invitation (each confirms its own)" }),
        staff(["field:requestedById"], T("application_created")),
    ),
    "hr.recruitment.application_stage_changed.v1": notify(
        candidate(T("candidate_under_review"), { when: "toStage screening (from applied)" }),
        candidate(T("candidate_application_closed"), { when: "toStage rejected, after the tenant's rejection delay; cancelled if reinstated" }),
    ),
    "hr.recruitment.application_next_round.v1": notify(staff(["resolve:requisitionId.recruiterId", "resolve:requisitionId.requestedById"], T("application_next_round"))),
    "hr.recruitment.shortlist_proposed.v1": notify(staff(["resolve:requisitionId.recruiterId", "resolve:requisitionId.requestedById"], T("shortlist_proposed"))),
    "hr.recruitment.disposition_cancelled.v1": silent("The recruiter (or the stage change) cancelled it; visible in the scheduled disposition list"),
    "hr.recruitment.candidate_resume_parsed.v1": silent("Realtime refresh of the candidate profile; failures show in hr_candidate_resume_parse_status"),
    "hr.recruitment.candidate_duplicate_resolved.v1": silent("The recruiter resolved it; audit only"),
    "hr.recruitment.candidate_communication_sent.v1": silent("Records a message that was already delivered; audit and the communications log"),
    "hr.recruitment.candidate_communication_suppressed.v1": silent("A suppressed message (DNC, consent, anonymized, no email) is shown in the communications log; telling anyone would defeat the suppression"),

    // ── Interviews and scheduling ──────────────────────────────────────────
    "hr.recruitment.interview_scheduled.v1": notify(candidate(T("candidate_interview_scheduled"))),
    "hr.recruitment.interview_rescheduled.v1": notify(candidate(T("candidate_interview_rescheduled"))),
    "hr.recruitment.interview_cancelled.v1": notify(candidate(T("candidate_interview_cancelled"))),
    "hr.recruitment.interview_updated.v1": silent("Field edits; the panel's calendar invite carries time changes"),
    "hr.recruitment.interview_reschedule_requested.v1": notify(staff(["field:recruiterId"], T("interview_reschedule_requested"))),
    "hr.recruitment.interview_outcome_recorded.v1": silent("Realtime refresh; the decision prompt and the stage change carry the follow-up"),
    "hr.recruitment.interview_reminder.v1": notify(
        candidate(T("candidate_interview_reminder_24h"), { when: "recipientType CANDIDATE and kind REMINDER_24H" }),
        candidate(T("candidate_interview_reminder_1h"), { when: "recipientType CANDIDATE and kind REMINDER_1H" }),
        staff(["field:recipientEmployeeId"], T("interview_reminder"), {
            when: "recipientType INTERVIEWER or RECRUITER (kind REMINDER_24H, REMINDER_1H, FEEDBACK_NUDGE, FEEDBACK_ESCALATION)",
        }),
    ),
    "hr.recruitment.interview_decision_prompt.v1": notify(staff(["field:hiringManagerEmployeeId"], T("interview_decision_prompt"))),
    "hr.recruitment.interview_no_show.v1": notify(staff(["field:recruiterId"], T("interview_no_show"))),
    "hr.recruitment.interview_no_show_prompt.v1": notify(staff(["field:recruiterEmployeeId"], T("interview_no_show_prompt"))),
    "hr.recruitment.interview_calendar_synced.v1": silent("The calendar invite itself is the notification"),
    "hr.recruitment.interview_calendar_sync_failed.v1": notify(staff(["resolve:applicationId.recruiterId"], T("interview_calendar_sync_failed"))),
    "hr.recruitment.interview_slots_offered.v1": silent("The slot offer email is sent directly (template hr.recruitment.interview_slot_offer, see RECRUITMENT_DIRECT_HUB_TEMPLATES)"),
    "hr.recruitment.interview_slot_confirmed.v1": silent("interview_scheduled is emitted with it and carries the candidate message; the panel gets the calendar invite"),
    "hr.recruitment.interview_slot_offer_expired.v1": notify(staff(["resolve:applicationId.recruiterId"], T("interview_slot_offer_expired"))),
    "hr.recruitment.interview_slot_offer_cancelled.v1": silent("The recruiter cancelled or superseded it"),
    // Phase 6: the candidate declined every offered slot (coded reason).
    "hr.recruitment.interview_slots_declined.v1": notify(staff(["field:recruiterId", "field:offeredById"], T("interview_slots_declined"))),
    "hr.recruitment.interview_scorecard_submitted.v1": silent("Realtime refresh; the debrief prompt covers divergent panels"),
    "hr.recruitment.interview_notes_flagged.v1": notify(staff(["role:HR_ADMIN"], T("interview_notes_flagged"), { mode: "all" })),
    "hr.recruitment.interview_debrief_prompt.v1": notify(staff(["field:hiringManagerEmployeeId"], T("interview_debrief_prompt"))),
    "hr.recruitment.evaluation_summary_frozen.v1": notify(staff(["resolve:requisitionId.requestedById"], T("evaluation_summary_frozen"))),

    // ── On-site assessment (assessmentEvent builder) ───────────────────────
    "hr.recruitment.interview_assessment_required.v1": notify(
        candidate(T("candidate_assessment_arrival"), {
            when: "assessmentStatus REQUIRED and not reused",
            pending: "Arrival instructions template (p3b-notes/H.md) is not in the candidate-communication catalogue yet",
        }),
    ),
    "hr.recruitment.candidate_checked_in.v1": notify(
        staff(["field:recruiterId", "field:interviewerIds"], T("candidate_checked_in"), { mode: "all" }),
        // Phase 7: the candidate hears they are checked in for the on-site test.
        candidate(T("candidate_assessment_arrival"), { when: "the interview is still scheduled and the application not withdrawn" }),
    ),
    "hr.recruitment.test_session_issued.v1": silent("Reception issued it at the desk; realtime refresh of the live grid"),
    "hr.recruitment.test_session_started.v1": notify(staff(["field:interviewerIds"], T("test_session_started"), { mode: "all" })),
    // Phase 6 (kioskResume): reception moved a crashed session to a workstation.
    "hr.recruitment.test_session_resumed.v1": silent("Reception resumed it at the desk; the live grid refreshes and the result's integrity timeline records the resume"),
    "hr.recruitment.test_session_submitted.v1": silent("test_result_recorded follows with the band"),
    "hr.recruitment.test_result_recorded.v1": notify(
        staff(["field:recruiterId"], T("test_result_recorded"), { when: "band FAILED, REVIEW or INCOMPLETE" }),
        staff(["field:interviewerIds"], T("test_result_recorded"), { when: "band PASSED or BORDERLINE (report link)", mode: "all" }),
    ),
    "hr.recruitment.test_integrity_flagged.v1": notify(staff(["field:recruiterId"], T("test_integrity_flagged"))),
    "hr.recruitment.test_result_decided.v1": notify(staff(["field:interviewerIds"], T("test_result_decided"), { when: "decision RELEASE", mode: "all" })),
    "hr.recruitment.test_item_published.v1": silent("Item bank audit"),
    "hr.recruitment.test_item_retired.v1": silent("Item bank audit"),
    "hr.recruitment.test_item_flagged.v1": notify(staff(["role:ASSESSMENT_REVIEWER"], T("test_item_flagged"), { mode: "all" })),
    "hr.recruitment.test_blueprint_published.v1": silent("Blueprint audit; links moved are in the payload"),

    // ── Offers and the hire handoff ────────────────────────────────────────
    "hr.recruitment.offer_created.v1": silent("Drafting; the Approval Centre notifies its own approvers"),
    "hr.recruitment.offer_updated.v1": silent("Field edits; realtime refresh"),
    "hr.recruitment.offer_sent.v1": notify(candidate(T("candidate_offer_sent"))),
    "hr.recruitment.offer_accepted.v1": notify(staff(["field:createdById"], T("offer_accepted"))),
    "hr.recruitment.offer_declined.v1": notify(staff(["field:createdById"], T("offer_declined"))),
    "hr.recruitment.offer_withdrawn.v1": silent("The recruiter withdrew it; a candidate message is sent by hand (hr_candidate_communication_send)"),
    "hr.recruitment.offer_expiry_reminder.v1": notify(candidate(T("candidate_offer_expiry_reminder"))),
    "hr.recruitment.offer_expired.v1": notify(staff(["field:createdById", "field:recruiterId"], T("offer_expired"), { mode: "all" })),
    "hr.recruitment.offer_expiry_extended.v1": silent("The recruiter extended it; a candidate 'deadline extended' template is optional and not built"),
    // Phase 6 (offerExtensionApproval): the Approval Centre decided an extension.
    "hr.recruitment.offer_expiry_extension_decided.v1": notify(staff(["field:createdById", "field:recruiterId"], T("offer_expiry_extension_decided"), { mode: "all" })),
    "hr.recruitment.offer_letter_rendered.v1": silent("A letter version was rendered; audit only"),
    "hr.recruitment.offer_esign_sent.v1": silent("The e-signature provider emails the candidate"),
    "hr.recruitment.offer_esign_status_changed.v1": notify(staff(["resolve:offerId.createdById"], T("offer_esign_status_changed"), { when: "signatureStatus DECLINED or EXPIRED" })),
    "hr.recruitment.candidate_hired.v1": silent("handoff_completed announces the hire with the employee and checklist"),
    "hr.recruitment.handoff_completed.v1": notify(staff(["resolve:offerId.createdById"], T("handoff_completed"))),
    "hr.recruitment.handoff_failed.v1": notify(staff(["field:operatorId", "role:HR_ADMIN"], T("handoff_failed"), { channel: "in-app+email" })),

    // ── Talent pool, internal board, referrals, agencies ───────────────────
    "hr.recruitment.talent_pool_added.v1": silent("The recruiter added them; realtime refresh"),
    "hr.recruitment.talent_pool_removed.v1": silent("The recruiter removed them; realtime refresh"),
    // Phase 6 (invitationLinks): the invitation email with its accept/decline link.
    "hr.recruitment.talent_pool_invitation_sent.v1": notify(candidate(T("candidate_talent_pool_invitation"))),
    "hr.recruitment.talent_nurture_proposed.v1": notify(staff(["field:recruiterId"], T("talent_nurture_proposed"), { when: "proposedCount > 0; a null recruiterId is dropped (no hiring manager fallback)" })),
    "hr.recruitment.referral_submitted.v1": notify(staff(["field:recruiterId", "field:requestedById"], T("referral_submitted"))),
    "hr.recruitment.referral_bonus_eligible.v1": notify(staff(["role:HR_ADMIN"], T("referral_bonus_eligible"), { mode: "all" })),
    "hr.recruitment.agency_submission_received.v1": notify(staff(["field:recruiterId", "field:requestedById"], T("agency_submission_received"))),

    // ── Privacy operations ─────────────────────────────────────────────────
    "hr.recruitment.retention_dry_run_report.v1": notify(staff(["field:dataPolicyOwnerId", "role:HR_ADMIN"], T("retention_dry_run_report"), { channel: "in-app+email" })),
    "hr.recruitment.retention_apply_changed.v1": notify(staff(["field:dataPolicyOwnerId", "role:HR_ADMIN"], T("retention_apply_changed"), { channel: "in-app+email", mode: "all" })),
    "hr.recruitment.dsr_verification_requested.v1": silent("Audit and metrics only; the verification email is sent directly (hr.recruitment.dsr_verification) and unverified requests never reach HR"),
    "hr.recruitment.dsr_verified.v1": notify(staff(["field:dataPolicyOwnerId", "role:HR_ADMIN"], T("dsr_received"))),
    "hr.recruitment.dsr_sla_at_risk.v1": notify(staff(["field:handledById", "field:dataPolicyOwnerId", "role:HR_ADMIN"], T("dsr_sla_at_risk"), { channel: "in-app+email" })),
    "hr.recruitment.dsr_export_generated.v1": silent("Audit; the handler generated it and has the media id"),

    // ── Analytics ──────────────────────────────────────────────────────────
    // Phase 6: with no recipient configured and no recruiting lead found, the
    // payload carries recipientId null and notifyRole "HR" (the HR role).
    "hr.recruitment.analytics_alert_raised.v1": notify(staff(["field:recipientId", "role:HR_ADMIN"], T("analytics_alert_raised"), { channel: "in-app+email", when: "role:HR_ADMIN only when the payload says notifyRole HR" })),

    // ── Onboarding ─────────────────────────────────────────────────────────
    "hr.onboarding.checklist_created.v1": silent("handoff_completed and sessions_scheduled carry the messages"),
    "hr.onboarding.checklist_updated.v1": silent("Realtime refresh"),
    "hr.onboarding.task_added.v1": silent("Realtime refresh"),
    "hr.onboarding.task_updated.v1": silent("Realtime refresh"),
    "hr.onboarding.task_deleted.v1": silent("Realtime refresh"),
    "hr.onboarding.task_reminder.v1": notify(staff(["field:recipientId"], O("task_reminder"))),
    "hr.onboarding.buddy_assigned.v1": notify(staff(["field:buddyId"], O("buddy_assigned"))),
    "hr.onboarding.survey_submitted.v1": silent("Cohort completion is read in hr_onboarding_survey_completion_get"),
    "hr.onboarding.survey_issued.v1": notify(staff(["field:recipientId"], O("survey_issued"), { channel: "in-app+email" })),
    "hr.onboarding.survey_reminder.v1": notify(staff(["field:recipientId"], O("survey_reminder"), { channel: "in-app+email" })),
    "hr.onboarding.sessions_scheduled.v1": notify(
        staff(["field:employeeId"], O("sessions_scheduled")),
        staff(["field:assigneeIds"], O("sessions_scheduled_host"), { mode: "all" }),
    ),
    "hr.onboarding.session_calendar_synced.v1": silent("The provider's invite is the notification"),
    "hr.onboarding.session_calendar_sync_failed.v1": notify(staff(["field:assigneeId", "role:HR_ADMIN"], O("session_calendar_sync_failed"), { mode: "all" })),
    "hr.onboarding.readiness_at_risk.v1": notify(
        staff(["field:hrOwnerId", "role:HR_ADMIN"], O("readiness_at_risk"), { channel: "in-app+email" }),
        staff(["field:managerId"], O("readiness_at_risk"), { channel: "in-app+email" }),
    ),
    "hr.onboarding.provisioning_requested.v1": notify(
        staff(["field:assigneeId", "role:IT_STAFF"], O("provisioning_requested")),
        staff(["field:managerId"], O("provisioning_requested"), { when: "FYI to the hire's manager" }),
    ),
    "hr.onboarding.provisioning_updated.v1": notify(staff(["field:managerId"], O("provisioning_updated"), { when: "status REJECTED (day one at risk); other updates are queue refreshes" })),
    "hr.onboarding.provisioning_fulfilled.v1": notify(staff(["field:managerId"], O("provisioning_fulfilled"))),
    "hr.onboarding.document_uploaded.v1": notify(staff(["field:hrOwnerId", "role:HR_ADMIN"], O("document_uploaded"))),
    "hr.onboarding.document_signed.v1": notify(staff(["field:hrOwnerId", "role:HR_ADMIN"], O("document_signed"))),
    "hr.onboarding.document_reviewed.v1": notify(staff(["field:employeeId"], O("document_reviewed"), { when: "reviewStatus VERIFIED or REJECTED (the note stays in hr_self_onboarding_get)" })),
});

/**
 * Hub templates sent DIRECTLY by this service (sendCandidateEmail through
 * src/lib/notificationClient.js), not derived from an event: the address is
 * the recipient, the data is listed in the sender.
 */
export const RECRUITMENT_DIRECT_HUB_TEMPLATES = Object.freeze({
    "hr.recruitment.portal_email_verification": "Portal applicant: confirm the email address (candidateVerification.service)",
    "hr.recruitment.portal_status_link": "Portal applicant: the status-tracking link (candidateVerification.service)",
    "hr.recruitment.portal_application_confirmed": "Portal applicant: application received (candidateVerification.service)",
    "hr.recruitment.portal_application_confirmed_existing": "Portal applicant who already had a profile: application received",
    "hr.recruitment.portal_mailbox_notice": "Mailbox owner notice (category hr.recruitment.mailbox_notice) when someone applies with their address",
    "hr.recruitment.portal_draft_link": "Save-and-return draft link (applicationDraft.service)",
    "hr.recruitment.interview_slot_offer": "Candidate self-scheduling link (interview-slot-offer.service)",
    "hr.recruitment.dsr_verification": "Data-subject request verification link, category PRIVACY, 48 h (dsr-portal.service)",
});

/**
 * hr.recruitment.* / hr.onboarding.* literals in src/ that are NOT hub
 * templates (so the template scan does not mistake them for one).
 */
export const RECRUITMENT_NON_TEMPLATE_KEYS = Object.freeze({
    "hr.recruitment.freeze": "REST permission resource (hiring freeze routes)",
    "hr.recruitment.approval.matrix": "REST permission resource (requisition approval matrix routes)",
    "hr.recruitment.mailbox_notice": "Notification category of the mailbox owner notice",
    "hr.recruitment.interview": "Communication calendar source for interview invites",
    "hr.onboarding.session": "Communication calendar source for onboarding session invites",
    "hr.recruitment.agencyMembership": "Symbol description (recruitmentAccess AGENCY_MEMBERSHIP)",
});

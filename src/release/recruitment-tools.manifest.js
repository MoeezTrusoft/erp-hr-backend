// src/release/recruitment-tools.manifest.js
//
// Recruitment Phase 6 (go-live, plan 13.1) — the RELEASE MANIFEST for the
// recruitment MCP surface: every tool, the permission it asserts, and the RBAC
// keys each role needs to use it.
//
// Why it lives here: the gateway (edge deny-by-default map, keyed by tool
// name) and the RBAC service (permission seeds and role grants) are other
// repositories. They cannot see which permission a tool asserts, so in every
// phase so far their maps were written by hand from notes and drifted. This
// file is the source of truth they load; it is pure data (no imports, no I/O)
// so it can be copied or required as-is.
//
// It is MACHINE-CHECKED: tests/unit/release/recruitment-tools-manifest.test.js
// registers every registrar named below on a capturing server, calls each
// handler as a caller with NO permissions and reads the permission from the
// "Insufficient permissions: <resource>:<action>" refusal. It then grants
// exactly that key and checks the tool gets past the gate, and grants each
// other known resource alone and checks it does NOT (unless the entry declares
// `alsoAccepts`). A tool registered without an entry, an entry whose gate
// changed, or a registrar the manifest does not list fails the test.
//
//   resource  the permission key the tool asserts (hr:recruitment, ...)
//   action    the RBAC action; assertPermission maps the HTTP method the tool
//             passes through METHOD_ACTION: GET -> VIEW, POST -> CREATE,
//             PUT/PATCH -> EDIT, DELETE -> DELETE
//
// RBAC stores the same grant in its canonical dotted form (hasPermission):
// hr:recruitment + VIEW is "hr.recruitment.read"; see rbacScopeKey below.
//
// Row scope is NOT a permission: what a holder of hr:recruitment sees is cut
// by the caller's role claim through src/lib/recruitmentAccess.js (ORG,
// MANAGED, ASSIGNED, FINANCE, AGENCY, ASSESSMENT). The role table at the end of
// this file records both: the grants a role needs, and the scope its claim
// resolves to.
//
// HOW TO ADD A TOOL (the lead, when a stream's note adds one):
//   1. Add `tool("<name>", <REC|ONB|SELF|AGENCY|EMP>, "<VIEW|CREATE|EDIT|DELETE>")`
//      to its registrar's group below, in registration order (order is not
//      checked, membership is).
//   2. A new registrar: add `group("<file basename>", "<registerXxx>", [...])`
//      with the file under src/mcp/tools/ and the exported registrar's name.
//   3. Run the manifest test. If the tool's first check is not the permission
//      (or it accepts another grant), the test names it; add the `alsoAccepts`
//      option or fix the tool, with a comment saying why.
//   4. If a role in RECRUITMENT_ROLE_GRANTS must reach the tool, check its
//      grants cover it (the test fails for a tool no role can call).

const REC = "hr:recruitment";
const ONB = "hr:onboarding";
const SELF = "hr:self";
const AGENCY = "hr:recruitment_agency";
const EMP = "hr:employee";

/** The permission resources the recruitment surface asserts. */
export const RECRUITMENT_RESOURCES = Object.freeze({
    RECRUITMENT: REC,
    ONBOARDING: ONB,
    SELF,
    AGENCY,
    EMPLOYEE: EMP,
});

/** METHOD_ACTION's verbs, and RBAC's canonical names for them. */
export const RBAC_ACTIONS = Object.freeze(["VIEW", "CREATE", "EDIT", "DELETE", "EXPORT"]);
const CANONICAL_ACTION = Object.freeze({ VIEW: "read", CREATE: "create", EDIT: "update", DELETE: "delete", EXPORT: "export" });

/**
 * The RBAC key for a grant, in the canonical dotted form the verified service
 * JWT scope carries: ("hr:recruitment", "VIEW") -> "hr.recruitment.read".
 */
export function rbacScopeKey(resource, action) {
    const verb = CANONICAL_ACTION[action];
    if (!verb) throw new Error(`Unknown RBAC action: ${action}`);
    return `${String(resource).replaceAll(":", ".")}.${verb}`;
}

// The agency portal's grant check: hr:recruitment_agency or hr:recruitment,
// then the AGENCY scope only (see the group below).
const AGENCY_PORTAL_GATE = Object.freeze({ alsoAccepts: Object.freeze([REC]) });

function tool(name, resource, action, options = {}) {
    return Object.freeze({ name, resource, action, ...options });
}

function group(module, registrar, tools) {
    return Object.freeze({ module, registrar, tools: Object.freeze(tools) });
}

/**
 * Tool groups in the order src/mcp/toolRegistry.js mounts them (the same
 * registrars as tests/unit/mcp/recruitmentMcpInventory.test.js).
 */
export const RECRUITMENT_TOOL_GROUPS = Object.freeze([
    group("recruitmentTools", "registerRecruitmentTools", [
        tool("hr_requisitions_list", REC, "VIEW"),
        tool("hr_candidates_list", REC, "VIEW"),
        tool("hr_requisition_create", REC, "CREATE"),
        tool("hr_requisition_update", REC, "EDIT"),
        tool("hr_requisition_approve", REC, "EDIT"),
        tool("hr_requisition_post", REC, "CREATE"),
        tool("hr_requisition_delete", REC, "DELETE"),
        tool("hr_candidate_create", REC, "CREATE"),
        tool("hr_candidate_update", REC, "EDIT"),
        tool("hr_application_create", REC, "CREATE"),
        tool("hr_application_update_stage", REC, "EDIT"),
        tool("hr_application_update_status", REC, "EDIT"),
        tool("hr_interview_create", REC, "CREATE"),
        tool("hr_interview_update", REC, "EDIT"),
        tool("hr_offer_create", REC, "CREATE"),
        tool("hr_offer_update", REC, "EDIT"),
        tool("hr_offer_approve", REC, "EDIT"),
        tool("hr_offer_send", REC, "CREATE"),
        tool("hr_offer_handoff_get", REC, "VIEW"),
        tool("hr_offer_handoff_retry", REC, "CREATE"),
        tool("hr_offer_handoffs_failed_list", REC, "VIEW"),
        tool("hr_talent_pool_add", REC, "CREATE"),
        tool("hr_talent_pool_remove", REC, "DELETE"),
    ]),
    group("requisitionMgmtTools", "registerRequisitionMgmtTools", [
        tool("hr_requisitions_manage_list", REC, "VIEW"),
        tool("hr_requisition_manage_get", REC, "VIEW"),
        tool("hr_requisition_submit", REC, "EDIT"),
        tool("hr_requisition_reject", REC, "EDIT"),
        tool("hr_requisition_close", REC, "EDIT"),
        tool("hr_requisition_postings_list", REC, "VIEW"),
        tool("hr_requisition_posting_unpublish", REC, "EDIT"),
        tool("hr_requisition_withdraw", REC, "EDIT"),
        tool("hr_requisition_questions_list", REC, "VIEW"),
        tool("hr_requisition_question_create", REC, "EDIT"),
        tool("hr_requisition_question_update", REC, "EDIT"),
        tool("hr_requisition_question_deactivate", REC, "EDIT"),
        tool("hr_requisition_questions_reorder", REC, "EDIT"),
        tool("hr_requisitions_export", REC, "VIEW"),
    ]),
    group("candidatePipelineTools", "registerCandidatePipelineTools", [
        tool("hr_candidate_pipeline_get", REC, "VIEW"),
        tool("hr_candidate_pipeline_list", REC, "VIEW"),
        tool("hr_candidate_360_get", REC, "VIEW"),
    ]),
    group("interviewMgmtTools", "registerInterviewMgmtTools", [
        tool("hr_interviews_manage_list", REC, "VIEW"),
        tool("hr_interview_manage_get", REC, "VIEW"),
        tool("hr_interview_feedback_consolidate", REC, "VIEW"),
        tool("hr_interview_score", REC, "CREATE"),
        tool("hr_interview_set_outcome", REC, "EDIT"),
        tool("hr_interview_cancel", REC, "EDIT"),
        tool("hr_interview_reschedule_request", REC, "CREATE"),
        tool("hr_interview_reschedule_confirm", REC, "EDIT"),
        tool("hr_interview_availability_check", REC, "VIEW"),
        tool("hr_interview_calendar_sync", REC, "EDIT"),
        tool("hr_interview_lifecycle_list", REC, "VIEW"),
        tool("hr_scorecard_templates_list", REC, "VIEW"),
        tool("hr_scorecard_template_create", REC, "CREATE"),
        tool("hr_scorecard_template_update", REC, "EDIT"),
        tool("hr_scorecard_template_deactivate", REC, "EDIT"),
        tool("hr_scorecard_template_link", REC, "CREATE"),
        tool("hr_scorecard_template_resolve", REC, "VIEW"),
    ]),
    group("offerMgmtTools", "registerOfferMgmtTools", [
        tool("hr_offers_manage_list", REC, "VIEW"),
        tool("hr_offer_manage_get", REC, "VIEW"),
        tool("hr_offer_create_full", REC, "CREATE"),
        tool("hr_offer_preview", REC, "VIEW"),
        tool("hr_offer_preboarding", REC, "EDIT"),
        tool("hr_offer_approval_policy_get", REC, "VIEW"),
        tool("hr_offer_approval_policy_set", REC, "EDIT"),
    ]),
    group("candidatePrivacyTools", "registerCandidatePrivacyTools", [
        tool("hr_candidate_consent_record", REC, "CREATE"),
        tool("hr_candidate_consent_list", REC, "VIEW"),
        tool("hr_candidate_dnc_record", REC, "CREATE"),
        tool("hr_candidate_dnc_list", REC, "VIEW"),
        tool("hr_candidate_dnc_lift", REC, "EDIT"),
        tool("hr_candidate_legal_hold_place", REC, "CREATE"),
        tool("hr_candidate_legal_hold_release", REC, "EDIT"),
        tool("hr_candidate_retention_policy_set", REC, "EDIT"),
        tool("hr_candidate_retention_preview", REC, "VIEW"),
        tool("hr_candidate_retention_apply", REC, "EDIT"),
        tool("hr_candidate_archive", REC, "EDIT"),
        tool("hr_candidate_anonymize", REC, "EDIT"),
        tool("hr_candidate_request_record", REC, "CREATE"),
        tool("hr_candidate_request_list", REC, "VIEW"),
        tool("hr_candidate_request_close", REC, "EDIT"),
    ]),
    group("talentPoolMgmtTools", "registerTalentPoolMgmtTools", [
        tool("hr_talent_pool_manage_list", REC, "VIEW"),
        tool("hr_talent_pool_profile_get", REC, "VIEW"),
        tool("hr_talent_pool_move_to_pipeline", REC, "CREATE"),
        tool("hr_talent_pool_invite", REC, "EDIT"),
        tool("hr_talent_pool_invitation_list", REC, "VIEW"),
        tool("hr_talent_pool_invitation_respond", REC, "EDIT"),
        tool("hr_talent_pool_segment", REC, "VIEW"),
        tool("hr_talent_pool_retention_sweep", REC, "EDIT"),
    ]),
    group("recruitmentAnalyticsTools", "registerRecruitmentAnalyticsTools", [
        tool("hr_recruitment_analytics_get", REC, "VIEW"),
        tool("hr_recruitment_analytics_drilldown", REC, "VIEW"),
        tool("hr_recruitment_analytics_export", REC, "VIEW"),
    ]),
    group("recruitmentExtraTools", "registerRecruitmentExtraTools", [
        tool("hr_candidate_merge", REC, "EDIT"),
        tool("hr_recruitment_cost_config_get", REC, "VIEW"),
        tool("hr_recruitment_cost_config_set", REC, "EDIT"),
        tool("hr_requisition_attachment_list", REC, "VIEW"),
        tool("hr_requisition_attachment_upload", REC, "EDIT"),
        tool("hr_requisition_attachment_delete", REC, "EDIT"),
        tool("hr_candidate_resume_upload", REC, "CREATE"),
    ]),
    group("applicationTools", "registerApplicationTools", [
        tool("hr_application_list", REC, "VIEW"),
        tool("hr_application_get", REC, "VIEW"),
        tool("hr_application_delete", REC, "DELETE"),
        tool("hr_application_screening_record", REC, "EDIT"),
        tool("hr_application_screenings_list", REC, "VIEW"),
        tool("hr_disposition_reasons_list", REC, "VIEW"),
        tool("hr_disposition_reason_version", REC, "EDIT"),
        tool("hr_disposition_reason_deactivate", REC, "EDIT"),
        tool("hr_application_shortlist_add", REC, "EDIT"),
        tool("hr_requisition_shortlist_list", REC, "VIEW"),
        tool("hr_application_shortlist_remove", REC, "EDIT"),
        tool("hr_interview_packet_add", REC, "CREATE"),
        tool("hr_interview_packet_list", REC, "VIEW"),
        tool("hr_interview_packet_remove", REC, "EDIT"),
        tool("hr_interview_packet_view", REC, "VIEW"),
    ]),
    // The two employee-resume tools act on EMPLOYEE records (skills from an
    // employee's CV), so they assert the employee resource, not recruitment.
    group("resumeTools", "registerResumeTools", [
        tool("hr_resume_parse_preview", EMP, "VIEW"),
        tool("hr_resume_employee_ingest", EMP, "CREATE"),
        tool("hr_resume_candidate_ingest", REC, "CREATE"),
        tool("hr_candidate_match", REC, "VIEW"),
        tool("hr_skills_reconcile", REC, "VIEW"),
        tool("hr_skill_alias_suggest", REC, "CREATE"),
    ]),
    group("onboardingTemplateTools", "registerOnboardingTemplateTools", [
        tool("hr_onboarding_template_list", REC, "VIEW"),
        tool("hr_onboarding_template_set", REC, "EDIT"),
        tool("hr_onboarding_template_deactivate", REC, "EDIT"),
        // Phase 6 onboarding gaps: bring a deactivated template back, and clear
        // the tenant default.
        tool("hr_onboarding_template_reactivate", REC, "EDIT"),
        tool("hr_onboarding_template_default_unset", REC, "EDIT"),
    ]),
    group("onboarding-provisioning.tools", "registerOnboardingProvisioningTools", [
        tool("hr_onboarding_provisioning_requests_list", ONB, "VIEW"),
        tool("hr_onboarding_provisioning_request_get", ONB, "VIEW"),
        tool("hr_onboarding_provisioning_request_update", ONB, "EDIT"),
    ]),
    group("onboarding-session-plan.tools", "registerOnboardingSessionPlanTools", [
        tool("hr_onboarding_session_plan_preview", ONB, "VIEW"),
        tool("hr_onboarding_session_calendar_resync", ONB, "CREATE"),
        tool("hr_onboarding_session_delete", ONB, "DELETE"),
    ]),
    group("onboarding-readiness.tools", "registerOnboardingReadinessTools", [
        tool("hr_onboarding_readiness_get", ONB, "VIEW"),
        tool("hr_onboarding_readiness_list", ONB, "VIEW"),
        tool("hr_onboarding_survey_completion_get", ONB, "VIEW"),
    ]),
    group("onboarding-self.tools", "registerOnboardingSelfTools", [
        tool("hr_self_onboarding_get", SELF, "VIEW"),
        tool("hr_self_onboarding_task_complete", SELF, "VIEW"),
        tool("hr_self_onboarding_task_reopen", SELF, "VIEW"),
        tool("hr_self_onboarding_document_upload", SELF, "VIEW"),
        tool("hr_self_onboarding_document_sign", SELF, "VIEW"),
        // Phase 6: the new hire's own copy of a policy document (self-scoped
        // DAM download), added this phase in onboarding-self.tools.js.
        tool("hr_self_onboarding_document_download", SELF, "VIEW"),
        tool("hr_self_onboarding_survey_submit", SELF, "VIEW"),
        tool("hr_onboarding_document_review", ONB, "EDIT"),
        tool("hr_onboarding_documents_pending_list", ONB, "VIEW"),
    ]),
    group("recruitment-settings.tools", "registerRecruitmentSettingsTools", [
        tool("hr_recruitment_settings_get", REC, "VIEW"),
        tool("hr_recruitment_settings_set", REC, "EDIT"),
        tool("hr_recruitment_source_report", REC, "VIEW"),
    ]),
    group("candidate-duplicate.tools", "registerCandidateDuplicateTools", [
        tool("hr_candidate_duplicate_list", REC, "VIEW"),
        tool("hr_candidate_duplicate_resolve", REC, "EDIT"),
        tool("hr_candidate_duplicate_detect", REC, "CREATE"),
    ]),
    group("recruitment-scoring.tools", "registerRecruitmentScoringTools", [
        tool("hr_application_score_get", REC, "VIEW"),
        tool("hr_requisition_rank_list", REC, "VIEW"),
        tool("hr_requisition_shortlist_propose", REC, "CREATE"),
        tool("hr_application_shortlist_proposal_confirm", REC, "EDIT"),
        tool("hr_application_shortlist_proposal_dismiss", REC, "EDIT"),
    ]),
    group("candidate-communication.tools", "registerCandidateCommunicationTools", [
        tool("hr_candidate_communications_list", REC, "VIEW"),
        tool("hr_candidate_communication_send", REC, "CREATE"),
        tool("hr_candidate_communication_cancel", REC, "EDIT"),
        tool("hr_recruitment_communication_templates_list", REC, "VIEW"),
    ]),
    group("resume-parse-status.tools", "registerResumeParseStatusTools", [
        tool("hr_candidate_resume_parse_status", REC, "VIEW"),
        tool("hr_candidate_resume_parse_retry", REC, "CREATE"),
    ]),
    group("recruitment-disposition.tools", "registerRecruitmentDispositionTools", [
        tool("hr_application_scheduled_disposition_list", REC, "VIEW"),
        tool("hr_application_scheduled_disposition_cancel", REC, "EDIT"),
    ]),
    group("offer-lifecycle.tools", "registerOfferLifecycleTools", [
        tool("hr_offer_decline_record", REC, "EDIT"),
        tool("hr_offer_decline_reasons_list", REC, "VIEW"),
        tool("hr_offer_expiry_extend", REC, "EDIT"),
        tool("hr_offer_band_check", REC, "VIEW"),
    ]),
    // Phase 6: offer expiry extensions re-approved through the Approval Centre.
    group("offer-extension.tools", "registerOfferExtensionTools", [
        tool("hr_offer_expiry_extension_get", REC, "VIEW"),
        tool("hr_offer_expiry_extension_withdraw", REC, "EDIT"),
    ]),
    group("offer-letter.tools", "registerOfferLetterTools", [
        tool("hr_offer_letter_templates_list", REC, "VIEW"),
        tool("hr_offer_letter_template_save", REC, "EDIT"),
        tool("hr_offer_letter_template_deactivate", REC, "EDIT"),
        tool("hr_offer_letter_render", REC, "CREATE"),
        tool("hr_offer_letter_versions_list", REC, "VIEW"),
        tool("hr_offer_esign_send", REC, "CREATE"),
        tool("hr_offer_esign_void", REC, "EDIT"),
    ]),
    group("recruitment-workspace.tools", "registerRecruitmentWorkspaceTools", [
        tool("hr_interview_workspace_get", REC, "VIEW"),
        tool("hr_requisition_manager_workspace_get", REC, "VIEW"),
    ]),
    group("interview-scheduling.tools", "registerInterviewSchedulingTools", [
        tool("hr_interview_slots_propose", REC, "CREATE"),
        tool("hr_interview_slot_offer_send", REC, "CREATE"),
        tool("hr_interview_slot_offer_cancel", REC, "EDIT"),
        tool("hr_interview_slot_offers_list", REC, "VIEW"),
        tool("hr_interview_no_show", REC, "EDIT"),
        tool("hr_interview_calendar_resync", REC, "CREATE"),
    ]),
    group("test-blueprint.tools", "registerTestBlueprintTools", [
        tool("hr_test_blueprints_list", REC, "VIEW"),
        tool("hr_test_blueprint_get", REC, "VIEW"),
        tool("hr_test_blueprint_create", REC, "CREATE"),
        tool("hr_test_blueprint_update", REC, "EDIT"),
        tool("hr_test_blueprint_approve", REC, "EDIT"),
        tool("hr_test_blueprint_publish", REC, "EDIT"),
        tool("hr_test_blueprint_link", REC, "EDIT"),
        tool("hr_test_blueprint_resolve", REC, "VIEW"),
        tool("hr_test_blueprint_preview", REC, "VIEW"),
    ]),
    group("test-workstation.tools", "registerTestWorkstationTools", [
        tool("hr_test_workstation_register", REC, "CREATE"),
        tool("hr_test_workstations_list", REC, "VIEW"),
        tool("hr_test_workstation_revoke", REC, "EDIT"),
        tool("hr_test_workstation_rotate", REC, "EDIT"),
    ]),
    group("test-item.tools", "registerTestItemTools", [
        tool("hr_test_items_list", REC, "VIEW"),
        tool("hr_test_item_get", REC, "VIEW"),
        tool("hr_test_item_create", REC, "CREATE"),
        tool("hr_test_item_update", REC, "EDIT"),
        tool("hr_test_item_submit_review", REC, "EDIT"),
        tool("hr_test_item_review_decide", REC, "EDIT"),
        tool("hr_test_item_retire", REC, "EDIT"),
        tool("hr_test_items_import", REC, "CREATE"),
        tool("hr_test_item_draft_ai", REC, "CREATE"),
        tool("hr_test_item_stats_get", REC, "VIEW"),
    ]),
    group("reception.tools", "registerReceptionTools", [
        tool("hr_reception_arrivals_list", REC, "VIEW"),
        tool("hr_candidate_checkin", REC, "CREATE"),
        tool("hr_test_session_issue", REC, "CREATE"),
        tool("hr_test_sessions_live_list", REC, "VIEW"),
        tool("hr_test_session_pause", REC, "EDIT"),
        tool("hr_test_session_resume", REC, "EDIT"),
        tool("hr_test_session_void", REC, "EDIT"),
        tool("hr_test_session_extend", REC, "EDIT"),
    ]),
    // Phase 6: reception resumes a sitting after a kiosk crash.
    group("kiosk-resume.tools", "registerKioskResumeTools", [
        tool("hr_test_session_resume_code_issue", REC, "EDIT"),
    ]),
    // Phase 6: bulk interview cancel with the same coded reason as a single cancel.
    group("interview-bulk-cancel.tools", "registerInterviewBulkCancelTools", [
        tool("hr_interviews_cancel_bulk", REC, "EDIT"),
    ]),
    group("test-result.tools", "registerTestResultTools", [
        tool("hr_test_result_get", REC, "VIEW"),
        tool("hr_test_results_list", REC, "VIEW"),
        tool("hr_test_result_decide", REC, "EDIT"),
        tool("hr_test_result_waive", REC, "EDIT"),
        tool("hr_test_analytics_get", REC, "VIEW"),
    ]),
    group("evaluation-form.tools", "registerEvaluationFormTools", [
        tool("hr_interview_form_get", REC, "VIEW"),
        tool("hr_interview_scorecard_draft_save", REC, "CREATE"),
        tool("hr_interview_questions_list", REC, "VIEW"),
        tool("hr_interview_question_create", REC, "CREATE"),
        tool("hr_interview_question_update", REC, "EDIT"),
        tool("hr_interview_question_retire", REC, "EDIT"),
        tool("hr_interview_form_draft_ai", REC, "CREATE"),
        tool("hr_interview_evaluation_summary_get", REC, "VIEW"),
        tool("hr_interview_evaluation_export", REC, "CREATE"),
        tool("hr_rater_calibration_get", REC, "VIEW"),
    ]),
    group("talent-nurture.tools", "registerTalentNurtureTools", [
        tool("hr_talent_nurture_runs_list", REC, "VIEW"),
        tool("hr_talent_nurture_run_get", REC, "VIEW"),
        tool("hr_talent_nurture_run_send", REC, "EDIT"),
        tool("hr_talent_nurture_run_dismiss", REC, "EDIT"),
    ]),
    group("internal-board.tools", "registerInternalBoardTools", [
        tool("hr_self_internal_jobs_list", SELF, "VIEW"),
        tool("hr_self_internal_job_get", SELF, "VIEW"),
        tool("hr_self_internal_job_apply", SELF, "VIEW"),
        tool("hr_self_referral_create", SELF, "VIEW"),
        tool("hr_self_referrals_list", SELF, "VIEW"),
    ]),
    group("internal-referral.tools", "registerInternalReferralTools", [
        tool("hr_recruitment_referrals_list", REC, "VIEW"),
        tool("hr_recruitment_referral_bonus_update", REC, "EDIT"),
    ]),
    group("recruitment-agency.tools", "registerRecruitmentAgencyTools", [
        tool("hr_recruitment_agencies_list", REC, "VIEW"),
        tool("hr_recruitment_agency_get", REC, "VIEW"),
        tool("hr_recruitment_agency_create", REC, "CREATE"),
        tool("hr_recruitment_agency_update", REC, "EDIT"),
        tool("hr_recruitment_agency_users_list", REC, "VIEW"),
        tool("hr_recruitment_agency_user_add", REC, "CREATE"),
        tool("hr_recruitment_agency_user_revoke", REC, "EDIT"),
        tool("hr_requisition_agency_assign", REC, "CREATE"),
        tool("hr_requisition_agency_unassign", REC, "EDIT"),
        tool("hr_recruitment_agency_submissions_list", REC, "VIEW"),
        tool("hr_recruitment_agency_submission_review", REC, "EDIT"),
    ]),
    // The agency's own portal. The grant check accepts hr:recruitment_agency OR
    // hr:recruitment with the same action (agencyCaller), and then refuses every
    // scope but AGENCY (HR-RECRUITMENT-AGENCY-SCOPE-REQUIRED), so a recruiter's
    // hr:recruitment passes the grant and is stopped by the scope. The RBAC
    // owner seeds hr:recruitment_agency for the agency roles ONLY.
    group("agency-portal.tools", "registerAgencyPortalTools", [
        tool("hr_recruitment_agency_portal_requisitions_list", AGENCY, "VIEW", AGENCY_PORTAL_GATE),
        tool("hr_recruitment_agency_portal_requisition_get", AGENCY, "VIEW", AGENCY_PORTAL_GATE),
        tool("hr_recruitment_agency_portal_submit", AGENCY, "CREATE", AGENCY_PORTAL_GATE),
        tool("hr_recruitment_agency_portal_submissions_list", AGENCY, "VIEW", AGENCY_PORTAL_GATE),
    ]),
    group("privacy-operations.tools", "registerPrivacyOperationsTools", [
        tool("hr_candidate_retention_runs_list", REC, "VIEW"),
        tool("hr_candidate_retention_run_get", REC, "VIEW"),
        tool("hr_candidate_retention_signoff", REC, "EDIT"),
        tool("hr_candidate_retention_apply_disable", REC, "EDIT"),
        tool("hr_candidate_retention_owner_set", REC, "EDIT"),
        tool("hr_candidate_request_export_generate", REC, "CREATE"),
    ]),
    group("recruitment-alerts.tools", "registerRecruitmentAlertTools", [
        tool("hr_recruitment_alert_thresholds_get", REC, "VIEW"),
        tool("hr_recruitment_alert_thresholds_set", REC, "EDIT"),
        tool("hr_recruitment_alerts_list", REC, "VIEW"),
        tool("hr_recruitment_alert_acknowledge", REC, "EDIT"),
    ]),]);

/** Every tool, flat, with its group's module and registrar. */
export const RECRUITMENT_TOOL_MANIFEST = Object.freeze(
    RECRUITMENT_TOOL_GROUPS.flatMap((g) => g.tools.map((t) => Object.freeze({ ...t, module: g.module, registrar: g.registrar }))),
);

/**
 * Recruitment-named tools in the HR registry that are NOT part of the
 * recruitment release: the pre-existing onboarding screens (onboardingTools,
 * onboardingMgmtTools, onboardingDashboardTools, onboardingDetailTools,
 * onboardingScheduleTools, onboardingPortalTools, onboardingPortalScreenTools)
 * and the skills catalogue. They predate the recruitment inventory and the
 * gateway maps them under its existing onboarding and skills entries. A NEW
 * tool whose name matches RECRUITMENT_TOOL_NAME_PATTERN goes in the groups
 * above, never here.
 */
export const RECRUITMENT_LEGACY_TOOLS = Object.freeze([
    "hr_onboarding_checklist_create", "hr_onboarding_checklist_update", "hr_onboarding_task_add",
    "hr_onboarding_task_update", "hr_onboarding_task_delete", "hr_onboarding_document_sign",
    "hr_onboarding_buddy_assign", "hr_onboarding_survey_submit", "hr_onboarding_manage_list",
    "hr_onboarding_dashboard_get", "hr_onboarding_add_new_hire", "hr_onboarding_export",
    "hr_onboarding_quick_progress", "hr_onboarding_detail_get", "hr_onboarding_task_create",
    "hr_onboarding_send_reminder", "hr_onboarding_schedule_list", "hr_onboarding_schedule_create",
    "hr_onboarding_schedule_update", "hr_onboarding_documents_list", "hr_onboarding_document_add",
    "hr_onboarding_preboarding_get", "hr_onboarding_preboarding_update", "hr_onboarding_feedback_submit",
    "hr_onboarding_feedback_view", "hr_onboarding_note_add", "hr_onboarding_activity_list",
    "hr_onboarding_portal_get", "hr_onboarding_portal_task_create", "hr_onboarding_portal_task_update",
    "hr_onboarding_portal_task_complete", "hr_onboarding_portal_task_delete",
    "hr_onboarding_portal_feedback_questions", "hr_onboarding_portal_feedback_submit",
    "hr_onboarding_portal_send_reminder", "hr_skill_list", "hr_skill_create",
]);

/** Tool names that belong to the recruitment surface unless listed as legacy. */
export const RECRUITMENT_TOOL_NAME_PATTERN =
    /^hr_(recruitment|requisition|candidate|application|talent|offer|interview|onboarding|self_onboarding|self_internal|self_referral|test_|reception|rater|scorecard|resume|skill|disposition)/;

/**
 * The gateway edge map: tool name -> the permission the gateway must check
 * before forwarding (resource, action and the canonical RBAC key). The gateway
 * owner loads this instead of hand-copying names (LOCAL_TOOL_PERMISSION_MAP).
 * @returns {Record<string, {resource:string, action:string, scope:string}>}
 */
export function recruitmentGatewayToolMap() {
    return Object.fromEntries(
        RECRUITMENT_TOOL_MANIFEST.map((t) => [t.name, { resource: t.resource, action: t.action, scope: rbacScopeKey(t.resource, t.action) }]),
    );
}

// ── RBAC: the keys each role needs ──────────────────────────────────────────
//
// Built from the plan's access matrix (section 11), the assessment roles
// (section 7.9) and the Open lines of every recruitment phase in
// coordination/STATE.md. Reviewed against what the code checks: the grants
// are what the tools above assert, the scope is what the role claim resolves
// to in src/lib/recruitmentAccess.js. Both are checked by the manifest test.
//
// Read this before seeding:
//   * The permission opens the SURFACE; the role claim cuts the ROWS. A role
//     claim the row-scope library does not know resolves to ORG (the whole
//     tenant, recruitmentAccess.js choice 1). So hr:recruitment must only ever
//     be granted to a role whose claim is in that vocabulary (scope below is
//     not null). IT staff and plain employees get NO hr:recruitment.
//   * MANAGED and ASSIGNED need the employeeId claim: without it a hiring
//     manager or interviewer claim falls through to ORG. The gateway must mint
//     employeeId for every staff login.
//   * The matrix's "HR admin only" lines (privacy operations, administration)
//     are not separable by key today: those tools assert hr:recruitment like
//     the recruiter's own. Recruiters therefore reach them (both are ORG).
//     Splitting them needs a dedicated resource (an open decision, see
//     scripts/RECRUITMENT-GOLIVE.runbook.md).
//   * Exports assert hr:recruitment VIEW, not EXPORT, so "export with the
//     export verb" is enforced by scope (AGENCY and MANAGED are refused by
//     assertNoAgencyExport and the export scope rules), not by RBAC.
//   * Approvals are the HR Approval Centre's keys (APPROVAL_CENTRE_KEYS), held
//     per Approval Centre role, not per recruitment role.

const grant = (resource, ...actions) => Object.freeze({ resource, actions: Object.freeze(actions) });
const ALL = ["VIEW", "CREATE", "EDIT", "DELETE"];

// REST-only resources (src/middlewares/routeAuthorization.middleware.js), no
// MCP tool: the hiring freeze and the requisition approval matrix routes.
export const RECRUITMENT_REST_ONLY_RESOURCES = Object.freeze(["hr.recruitment.freeze", "hr.recruitment.approval.matrix"]);

/**
 * The HR Approval Centre's keys (src/services/approval/service.js permits()).
 * Each stage needs a DIFFERENT person: the line manager must be the
 * initiator's own manager, the HR verifier must not be that manager, the
 * management approver must be neither. Requisitions and offers both pass
 * initiator -> line manager -> HR -> management.
 */
export const APPROVAL_CENTRE_KEYS = Object.freeze({
    INITIATOR: "hr.approvals.self", // every employee who submits (the hiring manager for a requisition, the offer's creator)
    LINE_MANAGER: "hr.approvals.manager",
    HR_VERIFIER: "hr.approvals.verify",
    MANAGEMENT: "hr.approvals.approve",
    AUDIT: "hr.approvals.read",
});

function role(def) {
    return Object.freeze({
        ...def,
        claims: Object.freeze(def.claims ?? []),
        grants: Object.freeze(def.grants ?? []),
        uses: Object.freeze(def.uses ?? []),
        mustNotHold: Object.freeze(def.mustNotHold ?? []),
    });
}

/**
 * Role -> { claims (role claims the gateway mints), scope (what they resolve
 * to; null = not a recruitment role), grants, uses (tools the matrix says the
 * role works with; the test checks the grants cover them), mustNotHold }.
 */
export const RECRUITMENT_ROLE_GRANTS = Object.freeze({
    // Matrix column "HR admin / recruiter (ORG)", administration and privacy
    // lines. Also the onboarding owner (Phase 4) and the employee resume tools.
    HR_ADMIN: role({
        claims: ["HR_ADMIN", "HR_MANAGER"],
        scope: "ORG",
        grants: [
            grant(REC, ...ALL),
            grant(ONB, ...ALL),
            grant(EMP, "VIEW", "CREATE"), // resume parse preview and employee ingest (held by HR on main already)
            grant(SELF, "VIEW"), // HR admins are employees too
            grant("hr.recruitment.freeze", ...ALL),
            grant("hr.recruitment.approval.matrix", "VIEW", "EDIT"),
        ],
        uses: [
            "hr_candidate_retention_signoff", "hr_candidate_retention_owner_set", "hr_candidate_retention_apply_disable",
            "hr_candidate_request_export_generate", "hr_recruitment_settings_set", "hr_test_workstation_register",
            "hr_onboarding_template_set", "hr_onboarding_document_review", "hr_offer_handoff_retry",
            "hr_recruitment_agency_create", "hr_recruitment_alert_thresholds_set", "hr_resume_employee_ingest",
        ],
    }),
    // Matrix column "HR admin / recruiter (ORG)": the whole funnel.
    RECRUITER: role({
        claims: ["RECRUITER", "TA_RECRUITER", "TALENT_ACQUISITION"],
        scope: "ORG",
        grants: [grant(REC, ...ALL), grant(SELF, "VIEW")],
        uses: [
            "hr_requisition_create", "hr_requisition_submit", "hr_requisition_post", "hr_application_screening_record",
            "hr_interview_create", "hr_offer_create", "hr_offer_send", "hr_offer_handoff_get",
            "hr_talent_nurture_run_send", "hr_recruitment_referral_bonus_update", "hr_recruitment_agency_submission_review",
            "hr_test_result_decide", "hr_recruitment_analytics_export", "hr_recruitment_alert_acknowledge",
        ],
    }),
    // Matrix column "Hiring manager (MANAGED)": own requisitions (requested,
    // approved or recruiter), screening review and feedback, blueprint
    // approval for own requisitions, analytics without export. Needs employeeId.
    HIRING_MANAGER: role({
        claims: ["HIRING_MANAGER", "DEPARTMENT_MANAGER", "LINE_MANAGER", "MANAGER"],
        scope: "MANAGED",
        grants: [grant(REC, "VIEW", "CREATE", "EDIT"), grant(SELF, "VIEW")],
        uses: [
            "hr_requisition_create", "hr_requisition_update", "hr_requisition_submit", "hr_requisition_manager_workspace_get",
            "hr_application_screening_record", "hr_interview_score", "hr_test_blueprint_approve",
            "hr_interview_evaluation_summary_get", "hr_recruitment_analytics_get",
        ],
        mustNotHold: [grant(REC, "DELETE")],
    }),
    // Matrix column "Interviewer (ASSIGNED)": own panels, packet, own form,
    // peers after own submission, the test report. Needs employeeId.
    INTERVIEWER: role({
        claims: ["INTERVIEWER", "PANELIST", "PANEL_MEMBER"],
        scope: "ASSIGNED",
        grants: [grant(REC, "VIEW", "CREATE"), grant(SELF, "VIEW")],
        uses: [
            "hr_interview_workspace_get", "hr_interview_packet_view", "hr_interview_form_get",
            "hr_interview_scorecard_draft_save", "hr_interview_score", "hr_test_result_get",
        ],
        mustNotHold: [grant(REC, "DELETE")],
    }),
    // Matrix column "Finance": budget fields, compensation, cost metrics,
    // offer policy read. Salary is unmasked only with hr:payroll VIEW, an
    // existing payroll key (not part of this surface).
    FINANCE: role({
        claims: ["FINANCE", "FINANCE_MANAGER", "FINANCE_ADMIN"],
        scope: "FINANCE",
        grants: [grant(REC, "VIEW"), grant(SELF, "VIEW")],
        uses: ["hr_offers_manage_list", "hr_offer_manage_get", "hr_recruitment_cost_config_get", "hr_offer_approval_policy_get"],
        mustNotHold: [grant(REC, "CREATE", "EDIT", "DELETE")],
    }),
    // Section 7.9 reception: today's arrivals, check-in, issue, pause, resume,
    // void and extend sessions. The reception tools assert hr:recruitment;
    // the ASSESSMENT scope gives these roles no recruitment rows.
    RECEPTION: role({
        claims: ["RECEPTION", "RECEPTIONIST"],
        scope: "ASSESSMENT",
        grants: [grant(REC, "VIEW", "CREATE", "EDIT")],
        uses: [
            "hr_reception_arrivals_list", "hr_candidate_checkin", "hr_test_session_issue", "hr_test_sessions_live_list",
            "hr_test_session_pause", "hr_test_session_resume", "hr_test_session_void", "hr_test_session_extend",
            "hr_test_session_resume_code_issue",
        ],
        mustNotHold: [grant(REC, "DELETE")],
    }),
    // Section 7.9 assessment author: draft items and blueprints, AI drafts.
    ASSESSMENT_AUTHOR: role({
        claims: ["ASSESSMENT_AUTHOR"],
        scope: "ASSESSMENT",
        grants: [grant(REC, "VIEW", "CREATE", "EDIT")],
        uses: [
            "hr_test_items_list", "hr_test_item_create", "hr_test_item_update", "hr_test_item_submit_review",
            "hr_test_item_draft_ai", "hr_test_blueprint_create", "hr_test_blueprint_update",
        ],
        mustNotHold: [grant(REC, "DELETE")],
    }),
    // Section 7.9 assessment reviewer: review and publish items, publish
    // approved blueprints (four-eyes is enforced in code, not by key).
    ASSESSMENT_REVIEWER: role({
        claims: ["ASSESSMENT_REVIEWER"],
        scope: "ASSESSMENT",
        grants: [grant(REC, "VIEW", "EDIT")],
        uses: ["hr_test_items_list", "hr_test_item_review_decide", "hr_test_item_retire", "hr_test_blueprint_publish"],
        mustNotHold: [grant(REC, "CREATE", "DELETE")],
    }),
    // Matrix column "Agency": assigned requisitions only, own submissions,
    // no export. hr:recruitment_agency only: several hr:recruitment tools are
    // tenant-wide (p5-notes/C.md), so an agency login must hold none of it.
    AGENCY: role({
        claims: ["AGENCY", "EXTERNAL_AGENCY", "AGENCY_USER"],
        scope: "AGENCY",
        grants: [grant(AGENCY, "VIEW", "CREATE")],
        uses: [
            "hr_recruitment_agency_portal_requisitions_list", "hr_recruitment_agency_portal_requisition_get",
            "hr_recruitment_agency_portal_submit", "hr_recruitment_agency_portal_submissions_list",
        ],
        mustNotHold: [grant(REC, ...ALL), grant(ONB, ...ALL), grant(SELF, ...ALL)],
    }),
    // IT staff (Phase 4): the provisioning queue. hr:onboarding is the only
    // key the tools check, and it also opens HR's onboarding tools; a narrower
    // IT resource is an open item. Not a recruitment role claim.
    IT_STAFF: role({
        claims: ["IT_SUPPORT", "IT_ADMIN"],
        scope: null,
        grants: [grant(ONB, "VIEW", "EDIT"), grant(SELF, "VIEW")],
        uses: ["hr_onboarding_provisioning_requests_list", "hr_onboarding_provisioning_request_get", "hr_onboarding_provisioning_request_update"],
        mustNotHold: [grant(REC, ...ALL), grant(ONB, "CREATE", "DELETE")],
    }),
    // Every employee (matrix column "Employee"): the internal board, own
    // referrals, and a new hire's own onboarding portal. hr:self is the
    // employee self-service family (as payslips); it is pinned to the
    // caller's employeeId claim in code.
    EMPLOYEE: role({
        claims: ["EMPLOYEE"],
        scope: null,
        grants: [grant(SELF, "VIEW")],
        uses: [
            "hr_self_internal_jobs_list", "hr_self_internal_job_apply", "hr_self_referral_create", "hr_self_referrals_list",
            "hr_self_onboarding_get", "hr_self_onboarding_task_complete", "hr_self_onboarding_document_upload",
            "hr_self_onboarding_document_sign", "hr_self_onboarding_survey_submit",
        ],
        mustNotHold: [grant(REC, ...ALL), grant(ONB, ...ALL), grant(AGENCY, ...ALL)],
    }),
});

/**
 * The canonical RBAC keys one role needs ("hr.recruitment.read", ...), for
 * the RBAC owner's seed script.
 * @param {keyof typeof RECRUITMENT_ROLE_GRANTS} roleName
 * @returns {string[]}
 */
export function recruitmentRoleScopes(roleName) {
    const def = RECRUITMENT_ROLE_GRANTS[roleName];
    if (!def) throw new Error(`Unknown recruitment role: ${roleName}`);
    return def.grants.flatMap((g) => g.actions.map((a) => rbacScopeKey(g.resource, a)));
}

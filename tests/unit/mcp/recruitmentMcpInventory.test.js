// REQ-RECRUITMENT-MCP-EXPOSURE-01 (HR side) — the Recruitment MCP TOOL inventory
// is pinned here so drift is loud.
//
// Why this test exists: the gateway's edge deny-by-default pre-check keys off
// tool NAME (LOCAL_TOOL_PERMISSION_MAP). A Recruitment tool that HR registers
// but the gateway does not map silently skips the edge gate — which is exactly
// how the whole candidate-privacy family, offer approval/handoff, the
// application list and the analytics export ended up exposed-but-ungated.
//
// The gateway side must pin the same names in
// erp-gateway-backend/tests/hr-recruitment-mcp-exposure.test.js (that count is
// not visible from this repository; check it there). Adding or removing a
// Recruitment tool must update BOTH files; this one fails first, naming the
// delta, so the gateway map cannot be forgotten.
//
// `resource(...)` registrations are intentionally NOT collected: a resource is
// served by resources/read, which the gateway does not gate by permission, and
// counting them would inflate the tool surface (e.g. hr://recruitment/tags is a
// resource, not the tool hr_recruitment_tags_list).

import { describe, it, expect } from "@jest/globals";

import { registerRecruitmentTools } from "../../../src/mcp/tools/recruitmentTools.js";
import { registerRequisitionMgmtTools } from "../../../src/mcp/tools/requisitionMgmtTools.js";
import { registerCandidatePipelineTools } from "../../../src/mcp/tools/candidatePipelineTools.js";
import { registerInterviewMgmtTools } from "../../../src/mcp/tools/interviewMgmtTools.js";
import { registerOfferMgmtTools } from "../../../src/mcp/tools/offerMgmtTools.js";
import { registerCandidatePrivacyTools } from "../../../src/mcp/tools/candidatePrivacyTools.js";
import { registerTalentPoolMgmtTools } from "../../../src/mcp/tools/talentPoolMgmtTools.js";
import { registerRecruitmentAnalyticsTools } from "../../../src/mcp/tools/recruitmentAnalyticsTools.js";
import { registerRecruitmentExtraTools } from "../../../src/mcp/tools/recruitmentExtraTools.js";
import { registerApplicationTools } from "../../../src/mcp/tools/applicationTools.js";
import { registerResumeTools } from "../../../src/mcp/tools/resumeTools.js";
import { registerOnboardingTemplateTools } from "../../../src/mcp/tools/onboardingTemplateTools.js";
import { registerRecruitmentSettingsTools } from "../../../src/mcp/tools/recruitment-settings.tools.js";
import { registerCandidateDuplicateTools } from "../../../src/mcp/tools/candidate-duplicate.tools.js";
import { registerRecruitmentScoringTools } from "../../../src/mcp/tools/recruitment-scoring.tools.js";
import { registerCandidateCommunicationTools } from "../../../src/mcp/tools/candidate-communication.tools.js";
import { registerResumeParseStatusTools } from "../../../src/mcp/tools/resume-parse-status.tools.js";
import { registerRecruitmentDispositionTools } from "../../../src/mcp/tools/recruitment-disposition.tools.js";
import { registerOfferLifecycleTools } from "../../../src/mcp/tools/offer-lifecycle.tools.js";
import { registerOfferLetterTools } from "../../../src/mcp/tools/offer-letter.tools.js";
import { registerRecruitmentWorkspaceTools } from "../../../src/mcp/tools/recruitment-workspace.tools.js";
import { registerInterviewSchedulingTools } from "../../../src/mcp/tools/interview-scheduling.tools.js";
import { registerTestBlueprintTools } from "../../../src/mcp/tools/test-blueprint.tools.js";
import { registerTestWorkstationTools } from "../../../src/mcp/tools/test-workstation.tools.js";
import { registerAllTools } from "../../../src/mcp/toolRegistry.js";

// module → registrar. This is the Recruitment surface: the tool files the
// registry mounts for requisitions, candidates, applications, interviews,
// offers, talent pools, privacy, analytics and resume ingestion.
const RECRUITMENT_REGISTRARS = [
  ["recruitmentTools", registerRecruitmentTools],
  ["requisitionMgmtTools", registerRequisitionMgmtTools],
  ["candidatePipelineTools", registerCandidatePipelineTools],
  ["interviewMgmtTools", registerInterviewMgmtTools],
  ["offerMgmtTools", registerOfferMgmtTools],
  ["candidatePrivacyTools", registerCandidatePrivacyTools],
  ["talentPoolMgmtTools", registerTalentPoolMgmtTools],
  ["recruitmentAnalyticsTools", registerRecruitmentAnalyticsTools],
  ["recruitmentExtraTools", registerRecruitmentExtraTools],
  ["applicationTools", registerApplicationTools],
  ["resumeTools", registerResumeTools],
  // FR-13 residue — tenant-configurable onboarding checklist templates. Its
  // tools serve the recruitment handoff's checklist seeding, so they belong to
  // this inventory (the gateway edge map gates them with the rest).
  ["onboardingTemplateTools", registerOnboardingTemplateTools],
  // Phase 2 — intake and screening.
  ["recruitmentSettingsTools", registerRecruitmentSettingsTools],
  ["candidateDuplicateTools", registerCandidateDuplicateTools],
  ["recruitmentScoringTools", registerRecruitmentScoringTools],
  ["candidateCommunicationTools", registerCandidateCommunicationTools],
  ["resumeParseStatusTools", registerResumeParseStatusTools],
  ["recruitmentDispositionTools", registerRecruitmentDispositionTools],
  // Phase 3a — interview and offer orchestration.
  ["offerLifecycleTools", registerOfferLifecycleTools],
  ["offerLetterTools", registerOfferLetterTools],
  ["recruitmentWorkspaceTools", registerRecruitmentWorkspaceTools],
  ["interviewSchedulingTools", registerInterviewSchedulingTools],
  // Phase 3b — on-site assessment and evaluation forms.
  ["testBlueprintTools", registerTestBlueprintTools],
  ["testWorkstationTools", registerTestWorkstationTools],
];

function collect(register) {
  const tools = [];
  const resources = [];
  register({
    tool: (name) => tools.push(name),
    // Contract-driven registrars on main use the newer registerTool API.
    registerTool: (name) => tools.push(name),
    resource: (name) => resources.push(name),
  });
  return { tools, resources };
}

const collected = new Map();
for (const [module, register] of RECRUITMENT_REGISTRARS) {
  collected.set(module, collect(register));
}

// The pinned surface. Mirrors the gateway map (hr-recruitment-mcp-exposure).
const EXPECTED_PER_MODULE = Object.freeze({
  recruitmentTools: 23, // + hr_offer_handoffs_failed_list (Phase 9 operator fleet view)
  requisitionMgmtTools: 14,
  candidatePipelineTools: 3, // + hr_candidate_360_get (F-14)
  interviewMgmtTools: 16,
  offerMgmtTools: 7, // + hr_offer_approval_policy_get/_set (FR-09 residue)
  candidatePrivacyTools: 15,
  talentPoolMgmtTools: 8, // + the invitation lifecycle, segment and pool sweep (FR-10 residue)
  recruitmentAnalyticsTools: 3, // + hr_recruitment_analytics_drilldown (NFR-12)
  recruitmentExtraTools: 7, // + hr_candidate_merge (FR-04.10) + the 3 requisition attachment tools (§1.4 decision B2)
  onboardingTemplateTools: 3, // FR-13 residue — list/set/deactivate
  applicationTools: 15,
  resumeTools: 6,
  recruitmentSettingsTools: 3, // Phase 2: settings get/set + source report
  candidateDuplicateTools: 3, // Phase 2: duplicate list/resolve/detect
  recruitmentScoringTools: 5, // Phase 2: score, rank, propose, confirm, dismiss
  candidateCommunicationTools: 4, // Phase 2: list, send, cancel, templates
  resumeParseStatusTools: 2, // Phase 2: parse status + re-queue
  recruitmentDispositionTools: 2, // Phase 2: scheduled disposition list + cancel
  offerLifecycleTools: 4, // Phase 3a: decline record + reasons, expiry extend, band check
  offerLetterTools: 7, // Phase 3a: letter templates, render, versions, e-signature send/void
  recruitmentWorkspaceTools: 2, // Phase 3a: interviewer and hiring manager workspaces
  interviewSchedulingTools: 6, // Phase 3a: slot offers, no-show, calendar re-sync
  testBlueprintTools: 9, // Phase 3b: blueprints, dual approval, publish, link, resolve, preview
  testWorkstationTools: 4, // Phase 3b: kiosk register, list, revoke, rotate
});

const EXPECTED_TOOLS = Object.freeze([
  "hr_candidate_360_get",
  "hr_application_create",
  "hr_application_delete",
  "hr_application_get",
  "hr_application_list",
  "hr_application_screening_record",
  "hr_application_screenings_list",
  "hr_application_shortlist_add",
  "hr_application_shortlist_remove",
  "hr_application_update_stage",
  "hr_application_update_status",
  "hr_candidate_anonymize",
  "hr_candidate_archive",
  "hr_candidate_consent_list",
  "hr_candidate_consent_record",
  "hr_candidate_create",
  "hr_candidate_dnc_lift",
  "hr_candidate_dnc_list",
  "hr_candidate_dnc_record",
  "hr_candidate_legal_hold_place",
  "hr_candidate_legal_hold_release",
  "hr_candidate_pipeline_get",
  "hr_candidate_pipeline_list",
  "hr_candidate_request_close",
  "hr_candidate_request_list",
  "hr_candidate_request_record",
  "hr_candidate_resume_upload",
  "hr_requisition_attachment_delete",
  "hr_requisition_attachment_list",
  "hr_requisition_attachment_upload",
  "hr_candidate_retention_apply",
  "hr_candidate_retention_policy_set",
  "hr_candidate_retention_preview",
  "hr_candidate_update",
  "hr_candidate_merge",
  "hr_candidates_list",
  "hr_disposition_reasons_list",
  "hr_disposition_reason_deactivate",
  "hr_disposition_reason_version",
  "hr_interview_availability_check",
  "hr_interview_calendar_sync",
  "hr_interview_cancel",
  "hr_interview_create",
  "hr_interview_feedback_consolidate",
  "hr_interview_lifecycle_list",
  "hr_interview_manage_get",
  "hr_interview_packet_add",
  "hr_interview_packet_list",
  "hr_interview_packet_remove",
  "hr_interview_packet_view",
  "hr_interview_reschedule_confirm",
  "hr_interview_reschedule_request",
  "hr_interview_score",
  "hr_scorecard_template_create",
  "hr_scorecard_template_deactivate",
  "hr_scorecard_template_link",
  "hr_scorecard_template_resolve",
  "hr_scorecard_template_update",
  "hr_interview_set_outcome",
  "hr_interview_update",
  "hr_interviews_manage_list",
  "hr_offer_approve",
  "hr_offer_create",
  "hr_offer_create_full",
  "hr_offer_handoff_get",
  "hr_offer_handoff_retry",
  "hr_offer_handoffs_failed_list",
  "hr_offer_manage_get",
  "hr_offer_approval_policy_get",
  "hr_offer_approval_policy_set",
  "hr_offer_preboarding",
  "hr_offer_preview",
  "hr_offer_send",
  "hr_offer_update",
  "hr_offers_manage_list",
  "hr_onboarding_template_deactivate",
  "hr_onboarding_template_list",
  "hr_onboarding_template_set",
  "hr_recruitment_analytics_drilldown",
  "hr_recruitment_analytics_export",
  "hr_recruitment_analytics_get",
  "hr_recruitment_cost_config_get",
  "hr_recruitment_cost_config_set",
  "hr_requisition_approve",
  "hr_requisition_close",
  "hr_requisition_create",
  "hr_requisition_delete",
  "hr_requisition_manage_get",
  "hr_requisition_post",
  "hr_requisition_posting_unpublish",
  "hr_requisition_postings_list",
  "hr_requisition_shortlist_list",
  "hr_requisition_reject",
  "hr_requisition_question_create",
  "hr_requisition_question_deactivate",
  "hr_requisition_question_update",
  "hr_requisition_questions_list",
  "hr_requisition_questions_reorder",
  "hr_requisition_submit",
  "hr_requisition_update",
  "hr_requisition_withdraw",
  "hr_requisitions_export",
  "hr_requisitions_list",
  "hr_requisitions_manage_list",
  "hr_candidate_match",
  "hr_resume_candidate_ingest",
  "hr_resume_employee_ingest",
  "hr_resume_parse_preview",
  "hr_skill_alias_suggest",
  "hr_skills_reconcile",
  "hr_talent_pool_add",
  "hr_talent_pool_invite",
  "hr_talent_pool_manage_list",
  "hr_talent_pool_move_to_pipeline",
  "hr_talent_pool_invitation_list",
  "hr_talent_pool_invitation_respond",
  "hr_talent_pool_profile_get",
  "hr_talent_pool_remove",
  "hr_talent_pool_retention_sweep",
  "hr_talent_pool_segment",
  // Phase 2 — intake and screening.
  "hr_recruitment_settings_get",
  "hr_recruitment_settings_set",
  "hr_recruitment_source_report",
  "hr_candidate_duplicate_list",
  "hr_candidate_duplicate_resolve",
  "hr_candidate_duplicate_detect",
  "hr_application_score_get",
  "hr_requisition_rank_list",
  "hr_requisition_shortlist_propose",
  "hr_application_shortlist_proposal_confirm",
  "hr_application_shortlist_proposal_dismiss",
  "hr_candidate_communications_list",
  "hr_candidate_communication_send",
  "hr_candidate_communication_cancel",
  "hr_recruitment_communication_templates_list",
  "hr_candidate_resume_parse_status",
  "hr_candidate_resume_parse_retry",
  "hr_application_scheduled_disposition_list",
  "hr_application_scheduled_disposition_cancel",
  // Phase 3a — interview and offer orchestration.
  "hr_offer_band_check",
  "hr_offer_decline_reasons_list",
  "hr_offer_decline_record",
  "hr_offer_expiry_extend",
  "hr_offer_letter_templates_list",
  "hr_offer_letter_template_save",
  "hr_offer_letter_template_deactivate",
  "hr_offer_letter_render",
  "hr_offer_letter_versions_list",
  "hr_offer_esign_send",
  "hr_offer_esign_void",
  "hr_interview_workspace_get",
  "hr_requisition_manager_workspace_get",
  "hr_interview_slots_propose",
  "hr_interview_slot_offer_send",
  "hr_interview_slot_offer_cancel",
  "hr_interview_slot_offers_list",
  "hr_interview_no_show",
  "hr_interview_calendar_resync",
  // Phase 3b — on-site assessment.
  "hr_test_blueprints_list",
  "hr_test_blueprint_get",
  "hr_test_blueprint_create",
  "hr_test_blueprint_update",
  "hr_test_blueprint_approve",
  "hr_test_blueprint_publish",
  "hr_test_blueprint_link",
  "hr_test_blueprint_resolve",
  "hr_test_blueprint_preview",
  "hr_test_workstation_register",
  "hr_test_workstations_list",
  "hr_test_workstation_revoke",
  "hr_test_workstation_rotate",
]);

const allRecruitmentTools = [...collected.values()].flatMap((c) => c.tools);

describe("Recruitment MCP tool inventory", () => {
  it(`registers exactly the pinned ${EXPECTED_TOOLS.length} tools — no more, no less`, () => {
    expect([...allRecruitmentTools].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("matches the per-module registration counts", () => {
    const counts = {};
    for (const [module, { tools }] of collected) counts[module] = tools.length;
    expect(counts).toEqual(EXPECTED_PER_MODULE);
  });

  it("per-module counts sum to the pinned inventory size", () => {
    const summed = Object.values(EXPECTED_PER_MODULE).reduce((a, b) => a + b, 0);
    expect(summed).toBe(EXPECTED_TOOLS.length);
    expect(allRecruitmentTools).toHaveLength(EXPECTED_TOOLS.length);
  });

  it("registers no duplicate tool name across the recruitment modules", () => {
    expect(new Set(allRecruitmentTools).size).toBe(allRecruitmentTools.length);
  });

  it("registers no duplicate tool name anywhere in the HR registry", () => {
    // A duplicate name would make the gateway map ambiguous and lets one module
    // silently shadow another's gate.
    const all = [];
    registerAllTools({
      tool: (name) => all.push(name),
      registerTool: (name) => all.push(name),
      resource: () => {},
    });
    expect(new Set(all).size).toBe(all.length);
    // 696 = the 559 on the recruitment branch plus the tools main added since
    // the fork (approval, assessment, separation, company setup, attendance,
    // payroll finance), counted after the merge with no duplicates.
    // 697 with hr_candidate_360_get (F-14).
    // Phase 2: + 3 settings and source report tools, + 3 duplicate tools,
    // + 5 scoring tools, + 4 communication tools, + 2 parse status tools,
    // + 2 scheduled disposition tools.
    // Phase 3a: + 4 offer lifecycle tools, + 7 offer letter tools, + 2 workspaces,
    // + 6 interview scheduling tools.
    // Phase 3b: + 9 blueprint tools, + 4 workstation tools.
    expect(all).toHaveLength(748);
    for (const name of EXPECTED_TOOLS) expect(all).toContain(name);
  });

  it("every privacy tool is registered as a TOOL (resources would bypass the gateway gate)", () => {
    const privacy = EXPECTED_TOOLS.filter((n) =>
      /consent|dnc|legal_hold|retention|anonymize|request_/.test(n)
    );
    // 15 = 14 + hr_talent_pool_retention_sweep (FR-10 residue), which the
    // /retention/ pattern catches and which IS a retention-surface tool: it acts
    // on the pool clock, so a resource-shaped registration would bypass the gate.
    expect(privacy).toHaveLength(15);
    for (const name of privacy) expect(allRecruitmentTools).toContain(name);
  });

  it("keeps the recruitment-tags RESOURCE out of the tool inventory", () => {
    // hr_recruitment_tags_list is a resource (hr://recruitment/tags). It is
    // served by resources/read and is deliberately not in the gateway tool map's
    // live set. This pins the distinction so a later registration as a TOOL
    // cannot slip in unnoticed.
    const tags = collected.get("recruitmentTools");
    expect(tags.resources).toContain("hr_recruitment_tags_list");
    expect(allRecruitmentTools).not.toContain("hr_recruitment_tags_list");
  });
});

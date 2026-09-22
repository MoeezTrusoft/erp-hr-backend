// REQ-RECRUITMENT-MCP-EXPOSURE-01 (HR side) — the Recruitment MCP TOOL inventory
// is pinned here so drift is loud.
//
// Why this test exists: the gateway's edge deny-by-default pre-check keys off
// tool NAME (LOCAL_TOOL_PERMISSION_MAP). A Recruitment tool that HR registers
// but the gateway does not map silently skips the edge gate — which is exactly
// how the whole candidate-privacy family, offer approval/handoff, the
// application list and the analytics export ended up exposed-but-ungated.
//
// The gateway side pins the same 73 names in
// erp-gateway-backend/tests/hr-recruitment-mcp-exposure.test.js. Adding or
// removing a Recruitment tool must update BOTH files; this one fails first,
// naming the delta, so the gateway map cannot be forgotten.
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
];

function collect(register) {
  const tools = [];
  const resources = [];
  register({
    tool: (name) => tools.push(name),
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
  candidatePipelineTools: 2,
  interviewMgmtTools: 16,
  offerMgmtTools: 7, // + hr_offer_approval_policy_get/_set (FR-09 residue)
  candidatePrivacyTools: 15,
  talentPoolMgmtTools: 4,
  recruitmentAnalyticsTools: 3, // + hr_recruitment_analytics_drilldown (NFR-12)
  recruitmentExtraTools: 7, // + hr_candidate_merge (FR-04.10) + the 3 requisition attachment tools (§1.4 decision B2)
  onboardingTemplateTools: 3, // FR-13 residue — list/set/deactivate
  applicationTools: 15,
  resumeTools: 6,
});

const EXPECTED_TOOLS = Object.freeze([
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
  "hr_talent_pool_profile_get",
  "hr_talent_pool_remove",
]);

const allRecruitmentTools = [...collected.values()].flatMap((c) => c.tools);

describe("Recruitment MCP tool inventory", () => {
  it("registers exactly the pinned 105 tools — no more, no less", () => {
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
      resource: () => {},
    });
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(555);
    for (const name of EXPECTED_TOOLS) expect(all).toContain(name);
  });

  it("every privacy tool is registered as a TOOL (resources would bypass the gateway gate)", () => {
    const privacy = EXPECTED_TOOLS.filter((n) =>
      /consent|dnc|legal_hold|retention|anonymize|request_/.test(n)
    );
    expect(privacy).toHaveLength(14);
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

// Public numeric families. The original domain slug remains a stable reason.
export const RECRUITMENT_ERROR_FAMILIES = Object.freeze({
  JOB_BOARD_SETTINGS: {
    code: "HR-5314",
    httpStatus: 422,
    message: "Job-board settings require review",
  },
  JOB_BOARD_CONFIG: {
    code: "HR-5310",
    httpStatus: 503,
    message: "Job-board publication is temporarily unavailable",
  },
  JOB_BOARD_NOT_FOUND: { code: "HR-5311", httpStatus: 404, message: "Not found" },
  JOB_BOARD_LEGACY: {
    code: "HR-5312",
    httpStatus: 409,
    message: "Legacy channel posting requires reconciliation",
  },
  JOB_BOARD_COMPLETE: {
    code: "HR-5313",
    httpStatus: 409,
    message: "Indeed requires the complete public careers inventory",
  },
  REQUISITION: {
    code: "HR-5100",
    httpStatus: 409,
    message: "Requisition workflow requirement not met",
  },
  PUBLICATION: {
    code: "HR-5200",
    httpStatus: 409,
    message: "Job publication or eligibility requirement not met",
  },
  APPLICATION: {
    code: "HR-5300",
    httpStatus: 409,
    message: "Application workflow requirement not met",
  },
  INTERVIEW: {
    code: "HR-5400",
    httpStatus: 409,
    message: "Interview workflow requirement not met",
  },
  OFFER: {
    code: "HR-5500",
    httpStatus: 409,
    message: "Offer or hire handoff requirement not met",
  },
  TALENT_POOL: {
    code: "HR-5600",
    httpStatus: 409,
    message: "Talent pool requirement not met",
  },
  PRIVACY: {
    code: "HR-5700",
    httpStatus: 409,
    message: "Candidate privacy requirement not met",
  },
  PORTAL: {
    code: "HR-5800",
    httpStatus: 400,
    message: "Careers portal request could not be processed",
  },
  AI: {
    code: "HR-5900",
    httpStatus: 503,
    message: "Recruitment AI is unavailable",
  },
  TEST: {
    code: "HR-6000",
    httpStatus: 409,
    message: "Candidate assessment requirement not met",
  },
  FORM: {
    code: "HR-6100",
    httpStatus: 409,
    message: "Interview evaluation requirement not met",
  },
});

export function recruitmentErrorFamily(reason) {
  if (
    typeof reason !== "string" ||
    !/^HR-(RECRUITMENT|PORTAL|RESUME|HANDOFF|AI)-[A-Z0-9-]+$/.test(reason)
  )
    return null;
  let family = "REQUISITION";
  if (/^HR-PORTAL-/.test(reason)) family = "PORTAL";
  else if (/AI-|RESUME-/.test(reason)) family = "AI";
  else if (/ANONYM|LEGAL-HOLD|RETENTION|CONSENT|DNC|MERGE-|DAR-|ARCHIVE-/.test(reason))
    family = "PRIVACY";
  else if (/INVITATION|SEGMENT|TALENT-POOL/.test(reason)) family = "TALENT_POOL";
  else if (/HANDOFF|OFFER-/.test(reason) && !/ACCEPTED-OFFER-REQUIRED/.test(reason))
    family = "OFFER";
  else if (
    /SCORECARD|SCHEDULE|PACKET|TEMPLATE|INTERVIEW-(FEEDBACK|DECISION|REASON)|OVERRIDE-REASON/.test(
      reason,
    )
  )
    family = "INTERVIEW";
  else if (/ASSESSMENT|BLUEPRINT|SESSION|WORKSTATION|ITEM-|RETAKE/.test(reason)) family = "TEST";
  else if (/FORM-/.test(reason)) family = "FORM";
  else if (/APPLICATIONS-CLOSED|POSTING|CHANNEL|URL-|CLOSES-AT/.test(reason))
    family = "PUBLICATION";
  else if (
    /STAGE-|SCREENING|INTERVIEW-(REQUIRED|OUTCOME)|ACCEPTED-OFFER-REQUIRED|REQUISITION-NOT-ACCEPTING|WORKFLOW|CANDIDATE-|ANALYTICS/.test(
      reason,
    )
  )
    family = "APPLICATION";
  return RECRUITMENT_ERROR_FAMILIES[family];
}

export const RECRUITMENT_DETAIL_ERRORS = Object.freeze({
  ONBOARDING_DOCUMENT_VALIDATION: {
    code: "HR-6200",
    httpStatus: 422,
    message: "Onboarding document validation failed",
  },
  ONBOARDING_DOCUMENT_UNAVAILABLE: {
    code: "HR-6201",
    httpStatus: 503,
    message: "Onboarding document service is temporarily unavailable",
  },
  APPROVAL_REQUIREMENT: {
    code: "HR-5101",
    httpStatus: 409,
    message: "Recruitment approval requirement not met",
  },
  POLICY_CHANGE: {
    code: "HR-5102",
    httpStatus: 409,
    message: "Recruitment policy update could not be applied",
  },
  APPLICATION_LIFECYCLE: {
    code: "HR-5301",
    httpStatus: 409,
    message: "Use the application lifecycle action",
  },
  FIT_EVIDENCE: {
    code: "HR-5302",
    httpStatus: 409,
    message: "Application evidence could not be processed",
  },
  AUTO_DISPOSITION: {
    code: "HR-5303",
    httpStatus: 409,
    message: "Automatic disposition requirement not met",
  },
  AGENCY_SOURCE: {
    code: "HR-5306",
    httpStatus: 409,
    message: "Agency ownership or review requirement not met",
  },
  APPLICATION_SOURCE: {
    code: "HR-5305",
    httpStatus: 409,
    message: "Application source or referral requirement not met",
  },
  RECRUITMENT_ACCESS: {
    code: "HR-5304",
    httpStatus: 403,
    message: "Recruitment operation is not permitted",
  },
  INTERVIEW_DECISION: {
    code: "HR-5401",
    httpStatus: 409,
    message: "Interview decision requirement not met",
  },
  INTERVIEW_OVERRIDE: {
    code: "HR-5402",
    httpStatus: 403,
    message: "Interview override requires an authorized HR administrator",
  },
  OFFER_DRAFT: {
    code: "HR-5501",
    httpStatus: 409,
    message: "Only draft offers can be sent",
  },
  HANDOFF_DISABLED: {
    code: "HR-5502",
    httpStatus: 503,
    message: "Offer acceptance is temporarily unavailable",
  },
  HIRE_CATEGORY: {
    code: "HR-5503",
    httpStatus: 422,
    message: "Choose an employee category",
  },
  OFFER_ANSWER: {
    code: "HR-5504",
    httpStatus: 409,
    message: "Offer is no longer answerable",
  },
  OFFER_IMMUTABLE: {
    code: "HR-5505",
    httpStatus: 409,
    message: "Sent and final offers are immutable",
  },
  OFFER_LIFECYCLE: {
    code: "HR-5506",
    httpStatus: 409,
    message: "Use the offer lifecycle action",
  },
  OFFER_APPLICATION: {
    code: "HR-5507",
    httpStatus: 404,
    message: "Application not found",
  },
  PREBOARDING_ACCEPTANCE: {
    code: "HR-5508",
    httpStatus: 409,
    message: "Accept the offer before starting preboarding",
  },
  OFFER_IDENTITY: {
    code: "HR-5509",
    httpStatus: 409,
    message: "Offer application identity is immutable",
  },
  OFFER_LETTER: {
    code: "HR-5511",
    httpStatus: 409,
    message: "Offer letter requirement not met",
  },
  OFFER_SIGNATURE_PROVIDER: {
    code: "HR-5510",
    httpStatus: 502,
    message: "Offer signature service could not complete the operation",
  },
  POOL_MEMBERSHIP: {
    code: "HR-5601",
    httpStatus: 409,
    message: "Talent pool membership requirement not met",
  },
  INVITATION: {
    code: "HR-5602",
    httpStatus: 409,
    message: "Invitation requirement not met",
  },
  CANDIDATE_PRIVACY: {
    code: "HR-5701",
    httpStatus: 409,
    message: "Candidate privacy or consent requirement not met",
  },
  CANDIDATE_ACCESS_EXPORT: {
    code: "HR-5702",
    httpStatus: 409,
    message: "Candidate data request could not be exported or fulfilled",
  },
  PORTAL_LINK: {
    code: "HR-5801",
    httpStatus: 404,
    message: "This candidate link is not valid",
  },
  PORTAL_POLICY_UNAVAILABLE: {
    code: "HR-5802",
    httpStatus: 503,
    message: "Applications are temporarily unavailable",
  },
  PORTAL_CONSENT: {
    code: "HR-5803",
    httpStatus: 400,
    message: "Review and accept the current privacy policy",
  },
  PORTAL_DOCUMENT: {
    code: "HR-5804",
    httpStatus: 400,
    message: "Candidate document could not be accepted",
  },
  CANDIDATE_COMMUNICATION: {
    code: "HR-5805",
    httpStatus: 409,
    message: "Candidate communication requirement not met",
  },
  COMMUNICATION_PROJECTION: {
    code: "HR-5806",
    httpStatus: 409,
    message: "Candidate communication event could not be processed",
  },
  VERIFIED_TENANT: {
    code: "HR-5901",
    httpStatus: 403,
    message: "Verified tenant required",
  },
  RATE_LIMIT_UNAVAILABLE: {
    code: "HR-5902",
    httpStatus: 503,
    message: "Service temporarily unavailable",
  },
  RATE_LIMIT: {
    code: "HR-5903",
    httpStatus: 429,
    message: "Too many requests",
  },
  TAXONOMY_TARGET: {
    code: "HR-5904",
    httpStatus: 404,
    message: "Canonical skill not found",
  },
  AI_AUDIT: {
    code: "HR-5905",
    httpStatus: 503,
    message: "AI evidence could not be audited",
  },
  ASSESSMENT_REQUIREMENT: {
    code: "HR-6001",
    httpStatus: 409,
    message: "Assessment requirement not met",
  },
  ASSESSMENT_ACCESS: {
    code: "HR-6002",
    httpStatus: 403,
    message: "Assessment operation is not permitted",
  },
  ASSESSMENT_DISABLED: {
    code: "HR-6003",
    httpStatus: 503,
    message: "Assessment capability is not enabled",
  },
  ASSESSMENT_DEFINITION: {
    code: "HR-6004",
    httpStatus: 422,
    message: "Assessment definition is invalid",
  },
  ASSESSMENT_CHANGED: {
    code: "HR-6005",
    httpStatus: 412,
    message: "Record changed; refresh before saving",
  },
  ASSESSMENT_RETAKE: {
    code: "HR-6006",
    httpStatus: 409,
    message: "Retake cooldown has not elapsed",
  },
  ASSESSMENT_SESSION: {
    code: "HR-6007",
    httpStatus: 401,
    message: "Session code is unavailable",
  },
  PINNED_EVALUATION: {
    code: "HR-6101",
    httpStatus: 409,
    message: "Use the pinned interview evaluation workflow",
  },
  EVALUATION_REQUIREMENT: {
    code: "HR-6102",
    httpStatus: 409,
    message: "Evaluation requirement not met",
  },
});

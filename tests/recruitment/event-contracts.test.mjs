import test from "node:test";
import assert from "node:assert/strict";
import { eventPayloadSchema, RECRUITMENT_WORKFLOW_EVENT_REGISTRY } from "@trusoft/contracts/events";
import * as builders from "../../src/services/hrEvents.js";
import { HR_ERROR_BY_CODE } from "../../src/constants/errorCodes.js";
const row = {
  id: 1,
  tenantId: "00000000-0000-4000-8000-000000000001",
  candidateId: 2,
  applicationId: 3,
  employeeId: 4,
  offerId: 5,
  jobRequisitionId: 6,
  checklistId: 7,
  createdById: 8,
  requestedById: 9,
  stage: "screening",
  status: "open",
  version: 0,
  scheduledAt: new Date("2026-10-21T09:00:00Z"),
  jobRequisition: { requestedById: 9 },
};
for (const name of [
  "candidateHiredEvent",
  "offerSentEvent",
  "offerAcceptedEvent",
  "offerHandoffCompletedEvent",
  "offerHandoffFailedEvent",
  "requisitionSubmittedEvent",
  "requisitionDecisionEvent",
  "requisitionPostedEvent",
  "requisitionClosedEvent",
  "applicationCreatedEvent",
  "applicationStageChangedEvent",
  "interviewScheduledEvent",
  "interviewOutcomeRecordedEvent",
  "interviewCancelledEvent",
  "interviewRescheduledEvent",
  "interviewRescheduleRequestedEvent",
])
  test(name + " has a registered strict payload", () => {
    const event = builders[name](row, {}, {});
    const schema = eventPayloadSchema(event.eventName);
    assert.ok(schema, event.eventName);
    const result = schema.safeParse(event.payload);
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
    assert.equal(
      schema.safeParse({
        ...event.payload,
        candidateEmail: "private@example.invalid",
      }).success,
      false,
    );
  });
test("recruitment policy and decision events validate closed states and metadata-only bodies", () => {
  assert.deepEqual(Object.keys(RECRUITMENT_WORKFLOW_EVENT_REGISTRY).sort(), [
    "hr.recruitment.agency_changed.v1",
    "hr.recruitment.analytics_threshold_breached.v1",
    "hr.recruitment.application_created.v1",
    "hr.recruitment.application_scored.v1",
    "hr.recruitment.application_shortlisted.v1",
    "hr.recruitment.application_stage_changed.v1",
    "hr.recruitment.candidate_hired.v1",
    "hr.recruitment.candidate_merged.v1",
    "hr.recruitment.candidate_preferences_changed.v1",
    "hr.recruitment.candidate_resume_parsed.v1",
    "hr.recruitment.communication_cancelled.v1",
    "hr.recruitment.communication_retry_requested.v1",
    "hr.recruitment.duplicate_suggestions_updated.v1",
    "hr.recruitment.handoff_completed.v1",
    "hr.recruitment.handoff_failed.v1",
    "hr.recruitment.interview_action_due.v1",
    "hr.recruitment.interview_cancelled.v1",
    "hr.recruitment.interview_outcome_recorded.v1",
    "hr.recruitment.interview_reschedule_requested.v1",
    "hr.recruitment.interview_rescheduled.v1",
    "hr.recruitment.interview_scheduled.v1",
    "hr.recruitment.offer_accepted.v1",
    "hr.recruitment.offer_sent.v1",
    "hr.recruitment.offer_signed.v1",
    "hr.recruitment.policy_changed.v1",
    "hr.recruitment.privacy_requested.v1",
    "hr.recruitment.referral_changed.v1",
    "hr.recruitment.requisition_closed.v1",
    "hr.recruitment.requisition_decided.v1",
    "hr.recruitment.requisition_posted.v1",
    "hr.recruitment.requisition_posting_changed.v1",
    "hr.recruitment.requisition_submitted.v1",
    "hr.recruitment.screening_recorded.v1",
    "hr.recruitment.shortlist_removed.v1",
    "hr.recruitment.talent_campaign_suggested.v1",
    "hr.recruitment.talent_invitation_changed.v1",
  ]);
  const schema = eventPayloadSchema("hr.recruitment.screening_recorded.v1");
  assert.equal(
    schema.safeParse({
      applicationId: "1",
      screeningId: "2",
      recordKind: "REVIEW",
      outcome: "ADVANCE",
    }).success,
    true,
  );
  assert.equal(
    schema.safeParse({
      applicationId: "1",
      screeningId: "2",
      recordKind: "APPROVED",
      outcome: "ADVANCE",
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      applicationId: "1",
      screeningId: "2",
      recordKind: "REVIEW",
      outcome: "ADVANCE",
      notes: "private",
    }).success,
    false,
  );
});
test("new screening and portal machine codes are registered", () => {
  for (const code of [
    "HR-5303",
    "HR-5304",
    "HR-5305",
    "HR-5306",
    "HR-5601",
    "HR-5602",
    "HR-5801",
    "HR-5802",
    "HR-5803",
    "HR-5804",
    "HR-5805",
    "HR-6001",
    "HR-6102",
  ])
    assert.ok(HR_ERROR_BY_CODE[code]);
});

test("resume completion publishes metadata without candidate document content", () => {
  const schema = eventPayloadSchema("hr.recruitment.candidate_resume_parsed.v1");
  assert.equal(
    schema.safeParse({ candidateId: "1", jobId: "2", modelVersion: null }).success,
    true,
  );
  assert.equal(
    schema.safeParse({
      candidateId: "1",
      jobId: "2",
      modelVersion: null,
      skills: ["Private evidence"],
    }).success,
    false,
  );
});

test("referral events reject contact and bonus details", () => {
  const schema = eventPayloadSchema("hr.recruitment.referral_changed.v1");
  const payload = {
    referralId: "11111111-1111-4111-8111-111111111111",
    version: 1,
  };
  assert.equal(schema.safeParse(payload).success, true);
  for (const extra of [
    { email: "private@example.invalid" },
    { bonusReason: "Private" },
    { referrerEmployeeId: 1 },
  ])
    assert.equal(schema.safeParse({ ...payload, ...extra }).success, false);
});

test("agency events expose identifiers and versions only", () => {
  const schema = eventPayloadSchema("hr.recruitment.agency_changed.v1");
  const payload = {
    agencyId: "11111111-1111-4111-8111-111111111111",
    requisitionId: "7",
    submissionId: null,
    version: 1,
  };
  assert.equal(schema.safeParse(payload).success, true);
  for (const extra of [
    { email: "private@example.invalid" },
    { decisionReason: "Private" },
    { candidateId: 1 },
    { assessment: { score: 90 } },
  ])
    assert.equal(schema.safeParse({ ...payload, ...extra }).success, false);
});

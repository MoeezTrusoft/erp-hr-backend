import test from "node:test";
import assert from "node:assert/strict";
import { RecruitmentPolicy } from "@trusoft/contracts/recruitment-policy";
const { analyticsThresholdBreaches } =
  await import("../../src/services/recruitmentAnalyticsAlerts.service.js");
const metric = {
  unavailable: false,
  timeToFill: { meanTimeToFillDays: 20, requisitionsFilled: 2 },
  attendanceConfirmedTimeToStart: {
    meanTimeToStartDays: null,
    startsMeasured: 0,
  },
  offerAcceptance: { acceptanceRatePct: 40, finalOutcomes: 2 },
  slaAging: { configured: false, breached: 0, openApplications: 0 },
};
test("sample floors, strict boundaries and missing evidence do not create alerts", () => {
  const policy = RecruitmentPolicy.parse({
    analyticsAlerts: {
      enabled: true,
      recipientEmployeeIds: [1],
      minimumSample: 3,
      maxTimeToFillDays: 10,
      minOfferAcceptancePct: 50,
      maxConfirmedTimeToStartDays: 0,
    },
  });
  assert.deepEqual(analyticsThresholdBreaches(metric, policy), []);
  policy.analyticsAlerts.minimumSample = 2;
  assert.deepEqual(
    analyticsThresholdBreaches(metric, policy).map((r) => r.kind),
    ["TIME_TO_FILL", "OFFER_ACCEPTANCE"],
  );
  policy.analyticsAlerts.maxTimeToFillDays = 20;
  policy.analyticsAlerts.minOfferAcceptancePct = 40;
  assert.deepEqual(analyticsThresholdBreaches(metric, policy), []);
});
test("policy rejects coerced booleans, invalid stages, values and missing recipients", () => {
  for (const p of [
    { analyticsAlerts: { enabled: "true" } },
    { analyticsAlerts: { enabled: true } },
    { stageSlaDays: { hired: 3 } },
    { stageSlaDays: { interview: -1 } },
    { analyticsAlerts: { minOfferAcceptancePct: 101 } },
  ])
    assert.equal(RecruitmentPolicy.safeParse(p).success, false);
});

test("declines, unresolved handoffs and configurable SLA counts have distinct thresholds", () => {
  const policy = RecruitmentPolicy.parse({
    analyticsAlerts: {
      enabled: true,
      recipientEmployeeIds: [1],
      minimumSample: 2,
      maxOfferDeclinePct: 30,
      maxFailedHandoffs: 0,
      maxSlaBreaches: 2,
    },
  });
  const m = {
    ...metric,
    offerAcceptance: {
      acceptanceRatePct: 20,
      declineRatePct: 40,
      finalOutcomes: 5,
    },
    handoffs: { failed: 1, attempted: 1 },
    slaAging: { configured: true, breached: 3, openApplications: 4 },
  };
  assert.deepEqual(
    analyticsThresholdBreaches(m, policy).map((r) => r.kind),
    ["OFFER_DECLINE", "FAILED_HANDOFFS", "STAGE_SLA_BREACHES"],
  );
  m.offerAcceptance.declineRatePct = 30;
  m.handoffs.failed = 0;
  m.slaAging.breached = 2;
  assert.deepEqual(analyticsThresholdBreaches(m, policy), []);
  m.offerAcceptance.declineRatePct = 90;
  m.offerAcceptance.finalOutcomes = 1;
  assert.deepEqual(analyticsThresholdBreaches(m, policy), []);
});

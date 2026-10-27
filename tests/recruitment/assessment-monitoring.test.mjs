import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAssessments } from "../../src/services/candidate-assessment/analytics.js";
const row = (id, patch = {}) => ({
  id,
  candidateId: id,
  requisitionId: 1,
  requisitionTitle: "Editor",
  blueprintId: 1,
  blueprintVersion: 1,
  blueprintName: "Editor test",
  jobFamily: "EDITOR",
  language: "en",
  passMarkPct: 60,
  status: "SUBMITTED",
  band: "PASSED",
  decision: null,
  extraTime: false,
  ...patch,
});
test("latest candidate attempt governs cohorts; raw totals retain attempt history", () => {
  const report = summarizeAssessments([
    row(2, { candidateId: 1, band: "FAILED" }),
    row(1),
    ...Array.from({ length: 4 }, (_, i) => row(i + 3)),
  ]);
  assert.equal(report.total, 6);
  assert.equal(report.monitoring.items[0].count, 5);
  assert.equal(report.monitoring.items[0].passRate, 0.8);
  for (const key of ["candidateId", "sessionId", "decisionReason", "email"])
    assert.equal(JSON.stringify(report).includes(key), false);
});
test("small cohorts and their complements are suppressed", () => {
  const report = summarizeAssessments(
    Array.from({ length: 9 }, (_, i) => row(i + 1, { extraTime: i < 4 })),
  );
  assert.equal(report.monitoring.items[0].count, 9);
  for (const cohort of report.monitoring.items[0].timeSupport) {
    assert.equal(cohort.count, null);
    assert.equal(cohort.passRate, null);
    assert.equal(cohort.suppressed, true);
  }
  assert.equal(summarizeAssessments([row(1)]).monitoring.items[0].count, null);
});
test("reviews and incomplete attempts do not depress scored pass rate; overrides use review denominator", () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    row(i, {
      band: i < 10 ? "FAILED" : "INCOMPLETE",
      status: i < 10 ? "SUBMITTED" : "EXPIRED",
      decision: i < 5 ? "OVERRIDE" : null,
    }),
  );
  const group = summarizeAssessments(rows).monitoring.items[0];
  assert.equal(group.completed, 10);
  assert.equal(group.passRate, 0);
  assert.equal(group.overrideRate, 0.25);
  assert.equal(group.incompleteRate, 0.5);
  assert.deepEqual(group.flags, ["OVERRIDE_REVIEW", "COMPLETION_REVIEW"]);
  const review = summarizeAssessments(
    Array.from({ length: 5 }, (_, i) => row(i, { band: "REVIEW" })),
  ).monitoring.items[0];
  assert.equal(review.passRate, null);
});
test("only sufficiently sized same-version cohorts create advisory gap flags", () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    row(i, { extraTime: i >= 20, band: i >= 20 ? "FAILED" : "PASSED" }),
  );
  const report = summarizeAssessments(rows).monitoring.items[0];
  assert.equal(report.comparisonEligible, true);
  assert.equal(report.timeSupportPassRateGap, 1);
  assert.deepEqual(report.flags, ["TIME_SUPPORT_REVIEW"]);
  const separate = summarizeAssessments(
    rows.map((r, i) => ({ ...r, blueprintVersion: i >= 20 ? 2 : 1 })),
  ).monitoring.items;
  assert.equal(separate.length, 2);
  assert.ok(
    separate.every(
      (g) => g.comparisonEligible === false && g.flags.length === 0,
    ),
  );
  const partial = summarizeAssessments(rows, { truncated: true });
  assert.deepEqual(partial.monitoring.items[0].flags, []);
});

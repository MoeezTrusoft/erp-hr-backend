import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||=
  "postgresql://assessment_test_user@127.0.0.1:55439/hr_task_assessment_test";
const { summarizeRaters } =
  await import("../../src/services/assessment/rater-metrics.js");
const limits = {
  minimumSamples: 10,
  level4ShareMax: 0.5,
  naShareMax: null,
  sharedCaseAgreementMin: 0.8,
  medianTaskSecondsMin: 30,
};
const revisions = Array.from({ length: 10 }, (_, i) =>
  ["A", "B"].map((rater) => ({
    assessmentRef: `${rater}-${i}`,
    sequence: i + 1,
    snapshot: {
      profile: { tasks: [{ taskCode: "TASK", familyCode: "ENGINEERING" }] },
      links: [{ taskCode: "TASK", state: "CONFIRMED", evidenceRef: `e-${i}` }],
      observations: [
        {
          taskCode: "TASK",
          taskVersion: 1,
          assessorCode: rater,
          durationSeconds: 120,
          dimensions: [
            { dimension: "K", status: "RATED", score: rater === "A" ? 4 : 3 },
            { dimension: "S", status: "PENDING", score: null },
            {
              dimension: "V",
              status: "NOT_APPLICABLE",
              reasonCode: "TIMING_NOT_MEANINGFUL",
              score: null,
            },
          ],
        },
      ],
    },
  })),
).flat();
const evidence = Array.from({ length: 10 }, (_, i) => ({
  id: `e-${i}`,
  caseRef: `case-${i}`,
}));
test("Consistency metrics compare the same cases without turning pending or N/A into scores", () => {
  const [a, b] = summarizeRaters(revisions, evidence, limits);
  assert.equal(a.dimensions.K.level4Share, 1);
  assert.equal(a.dimensions.S.observed, 0);
  assert.equal(a.dimensions.S.pending, 10);
  assert.equal(a.dimensions.V.naReasons.TIMING_NOT_MEANINGFUL, 10);
  assert.equal(a.dimensions.K.sharedCaseAgreement, 0);
  assert.ok(a.flags.includes("K_LEVEL4_SHARE"));
  assert.ok(b.flags.includes("K_SHARED_CASE_AGREEMENT"));
  assert.equal(a.medianTaskSeconds, 120);
  assert.equal(revisions[0].snapshot.observations[0].dimensions[0].score, 4);
});
test("Insufficient samples do not flag a rater and superseded revisions do not inflate counts", () => {
  const repeated = [
    revisions[0],
    { ...structuredClone(revisions[0]), sequence: 11 },
  ];
  const [a] = summarizeRaters(repeated, evidence, limits);
  assert.equal(a.taskCount, 1);
  assert.deepEqual(a.flags, []);
  assert.equal(a.dimensions.K.sharedCaseAgreement, null);
});

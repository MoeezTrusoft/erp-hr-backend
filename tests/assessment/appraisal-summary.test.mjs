import test from "node:test";
import assert from "node:assert/strict";
import { appraisalSummary } from "../../src/services/assessment/appraisal-summary.js";
const task = {
  taskCode: "API",
  taskVersion: 1,
  scope: "ROUTINE",
  complexity: "ROUTINE",
  technology: "NODE",
};
const snapshot = {
  observations: [
    {
      ...task,
      observedAt: "2026-10-10T10:00:00Z",
      dimensions: [
        { dimension: "K", status: "RATED", score: 2 },
        { dimension: "S", status: "PENDING", score: null },
        { dimension: "V", status: "NOT_APPLICABLE", score: null },
      ],
    },
  ],
  summaries: { K: { percentage: 50, coverage: 1 } },
};
const input = {
  assignment: {
    id: "assessment",
    profileRef: "profile",
    profileSnapshot: {
      tasks: [task],
      requirements: [
        { taskCode: "API", requiredK: 3, requiredS: 3, targetV: null },
      ],
    },
  },
  revision: { id: "revision", digest: "digest" },
  snapshot,
  previous: {
    id: "prior",
    snapshot: {
      profile: { tasks: [task] },
      observations: [
        {
          ...task,
          dimensions: [
            { dimension: "K", status: "RATED", score: 3 },
            { dimension: "S", status: "RATED", score: 3 },
          ],
        },
      ],
    },
  },
  evidence: [
    { id: "evidence", captureAt: "2026-10-10T10:00:00Z", sourceVersion: 1 },
  ],
  restrictions: [
    {
      id: "hold",
      taskCode: "API",
      cause: "EVIDENCE_WITHDRAWN",
      sourceRef: "evidence",
    },
  ],
  now: new Date("2026-10-15T10:00:00Z"),
};
test("Appraisal input distinguishes observed shortfall, pending evidence and N/A without an overall score", () => {
  const result = appraisalSummary(input);
  assert.equal(result.requirementGaps.length, 2);
  assert.equal(result.requirementGaps[0].gapType, "CAPABILITY_GAP");
  assert.equal(result.requirementGaps[0].gap, 1);
  assert.equal(result.requirementGaps[1].gapType, "EVIDENCE_GAP");
  assert.equal(result.requirementGaps[1].gap, null);
  assert.equal(result.tasks[0].dimensions[0].trend.delta, -1);
  assert.equal(result.tasks[0].dimensions[1].trend.delta, null);
  assert.equal(result.evidenceRecency[0].ageDays, 5);
  assert.equal(result.restrictions[0].restrictionRef, "hold");
  assert.equal("overall_rating" in result, false);
});
test("Different task versions or scopes do not produce a misleading numerical trend", () => {
  const changed = structuredClone(input);
  changed.previous.snapshot.observations[0].taskVersion = 2;
  assert.equal(
    appraisalSummary(changed).tasks[0].dimensions[0].trend.delta,
    null,
  );
  changed.previous.snapshot.observations[0].taskVersion = 1;
  changed.previous.snapshot.profile.tasks[0] = { ...task, scope: "ADVANCED" };
  assert.equal(
    appraisalSummary(changed).tasks[0].dimensions[0].trend.comparable,
    false,
  );
});

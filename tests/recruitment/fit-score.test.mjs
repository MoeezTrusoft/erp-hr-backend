import test from "node:test";
import assert from "node:assert/strict";
import { buildAliasIndex } from "../../src/lib/skillNormalization.js";
import {
  calculateApplicationFit,
  rankFitScores,
  requisitionSkillRequirements,
} from "../../src/lib/applicationFitScore.js";
const index = buildAliasIndex(
  [],
  [
    { id: 1, name: "Editing", tenantId: null },
    { id: 2, name: "Proofreading", tenantId: null },
    { id: 3, name: "Excel", tenantId: null },
  ],
  null,
);
const input = {
  index,
  candidateSkills: [{ name: "Editing" }, { name: "Excel" }],
  requirements: { required: ["Editing", "Proofreading"], preferred: ["Excel"] },
  experienceYears: 3,
  minimumExperienceYears: 5,
};
test("fit score uses declared weighted job evidence", () => {
  const s = calculateApplicationFit(input);
  assert.equal(s.scorePct, 62);
  assert.equal(s.explanation.features.required.matched, 1);
  assert.equal(s.explanation.components.length, 3);
  assert.equal(s.explanation.humanDecisionRequired, true);
});
test("protected attributes cannot affect score or feature fingerprint", () => {
  const baseline = calculateApplicationFit(input);
  const varied = calculateApplicationFit({
    ...input,
    gender: "female",
    age: 54,
    nationality: "other",
    salary: 100,
    candidateName: "Other",
  });
  assert.equal(baseline.inputHash, varied.inputHash);
  assert.equal(baseline.scorePct, varied.scorePct);
});
test("unmapped requirements and missing experience stay unscored", () => {
  assert.equal(
    calculateApplicationFit({
      ...input,
      requirements: { required: ["unmapped"] },
    }).scorePct,
    null,
  );
  assert.equal(
    calculateApplicationFit({ ...input, experienceYears: null }).scorePct,
    null,
  );
});
test("knockouts are explicit and a failed threshold gives zero", () => {
  const s = calculateApplicationFit({
    ...input,
    knockouts: [
      { questionId: 1, questionVersion: 1, minimumScore: 1, score: 0 },
    ],
  });
  assert.equal(s.scorePct, 0);
  assert.equal(s.knockoutFailed, true);
  assert.equal(
    calculateApplicationFit({
      ...input,
      knockouts: [
        { questionId: 1, questionVersion: 1, minimumScore: 1, score: null },
      ],
    }).scorePct,
    null,
  );
});
test("normalization keeps preferred skills separate and avoids duplicate weight", () => {
  assert.deepEqual(
    requisitionSkillRequirements({
      skills: [
        { name: "Editing", importance: "required" },
        { name: "Excel", importance: "preferred" },
      ],
    }),
    { required: ["Editing"], preferred: ["Excel"] },
  );
  const s = calculateApplicationFit({
    ...input,
    requirements: { required: ["Editing", "Editing"], preferred: ["Editing"] },
    minimumExperienceYears: null,
  });
  assert.equal(s.scorePct, 100);
  assert.equal(s.explanation.features.required.total, 1);
  assert.equal(s.explanation.features.preferred.total, 0);
});
test("top-decile proposal includes ties without taking a hiring action", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    applicationId: i + 1,
    scorePct: i < 3 ? 95 : 60,
    knockoutFailed: false,
  }));
  const ranks = rankFitScores(rows, { minimumScore: 70 });
  assert.equal(ranks.filter((r) => r.proposed).length, 3);
  assert.deepEqual(
    ranks.slice(0, 3).map((r) => r.rank),
    [1, 1, 1],
  );
  assert.equal(ranks[3].rank, 4);
});

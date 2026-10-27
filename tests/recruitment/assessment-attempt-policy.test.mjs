import test from "node:test";
import assert from "node:assert/strict";
import { attemptPolicy } from "../../src/services/candidate-assessment/attempt-policy.js";
const at = new Date("2026-01-01T12:00:00.000Z"),
  bp = { resultValidityDays: 90, retakeCooldownDays: 180 };
const attempt = {
  status: "SUBMITTED",
  issuedAt: at,
  startedAt: at,
  submittedAt: at,
};
const result = { id: 1, band: "PASSED", decision: null };
const days = (n) => new Date(+at + n * 86400000);
test("validity and cooldown use exact boundaries without a retest gap", () => {
  assert.equal(attemptPolicy(attempt, result, bp, days(89)).kind, "REUSE");
  assert.equal(attemptPolicy(attempt, result, bp, days(90)).kind, "COOLDOWN");
  assert.equal(attemptPolicy(attempt, result, bp, days(179)).kind, "COOLDOWN");
  assert.equal(attemptPolicy(attempt, result, bp, days(180)).kind, "NEW");
});
test("only completed clean successful results can be reused", () => {
  for (const band of ["FAILED", "REVIEW"])
    assert.equal(
      attemptPolicy(attempt, { ...result, band }, bp, days(1)).kind,
      "COOLDOWN",
    );
  assert.equal(
    attemptPolicy(attempt, { ...result, band: "BORDERLINE" }, bp, days(1)).kind,
    "REUSE",
  );
  assert.equal(
    attemptPolicy({ ...attempt, status: "VOIDED" }, result, bp, days(1)).kind,
    "REISSUE",
  );
  assert.equal(
    attemptPolicy({ ...attempt, status: "EXPIRED" }, null, bp, days(1)).kind,
    "REISSUE",
  );
  assert.equal(
    attemptPolicy({ ...attempt, status: "PAUSED" }, null, bp, days(1)).kind,
    "ACTIVE",
  );
});
test("a retest needs an attributed decision and does not waive the next attempt cooldown", () => {
  const failed = { ...result, band: "FAILED", decision: "RETEST" };
  assert.equal(attemptPolicy(attempt, failed, bp, days(1)).kind, "COOLDOWN");
  assert.equal(
    attemptPolicy(
      attempt,
      { ...failed, decidedById: 9, decisionReason: "Reviewed device failure" },
      bp,
      days(1),
    ).kind,
    "RETEST",
  );
  assert.equal(
    attemptPolicy(
      { ...attempt, submittedAt: days(2) },
      { ...result, band: "FAILED" },
      bp,
      days(3),
    ).kind,
    "COOLDOWN",
  );
  assert.equal(attemptPolicy(null, null, bp, days(1)).kind, "NEW");
});

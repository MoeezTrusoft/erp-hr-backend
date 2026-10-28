import assert from 'node:assert/strict';
import test from 'node:test';
import {
  legacyReviewCreate, legacyReviewUpdate, legacyFeedbackCreate,
  legacyFeedbackUpdate, legacyGoalCreate, legacyGoalUpdate,
  legacyGoalProgress, legacyGoalAlignment,
} from '../../src/validators/performance.schema.js';

test('legacy review boundary rejects identifier coercion, impossible dates and mass assignment', () => {
  const valid = { employeeId: '12', period_start: '2026-01-01', period_end: '2026-12-31' };
  assert.equal(legacyReviewCreate.parse(valid).employeeId, 12);
  for (const extra of [{ employeeId: true }, { employeeId: '1e2' }, { employeeId: '9007199254740992' },
    { period_start: '2026-02-30' }, { period_end: '2025-01-01' }, { tenantId: 'forged' },
    { status: 'FINALIZED' }, { employee: { connect: { id: 1 } } }]) {
    assert.equal(legacyReviewCreate.safeParse({ ...valid, ...extra }).success, false);
  }
});

test('legacy review updates reject conflicting rating aliases and unknown fields', () => {
  assert.equal(legacyReviewUpdate.safeParse({ overallRating: 5 }).success, true);
  for (const input of [{}, { overallRating: 6 }, { overallRating: 2, overall_rating: 4 },
    { overallRating: '5' }, { reviewerId: 12 }])
    assert.equal(legacyReviewUpdate.safeParse(input).success, false);
});

test('feedback validation preserves an explicit cleared rating and bounds content', () => {
  assert.equal(legacyFeedbackUpdate.parse({ rating: null }).rating, null);
  assert.equal(legacyFeedbackCreate.safeParse({ reviewId: 1, reviewerId: 2, feedback: ' ' }).success, false);
  assert.equal(legacyFeedbackCreate.safeParse({ reviewId: 1, reviewerId: 2, feedback: 'Valid', rating: -1 }).success, false);
  assert.equal(legacyFeedbackCreate.parse({ reviewId: 1, reviewerId: 2, feedback: 'Valid', rating: 0 }).rating, 0);
  assert.equal(legacyFeedbackUpdate.safeParse({ feedback: 'x'.repeat(4001) }).success, false);
});

test('legacy goals reject invalid intervals, nonfinite targets and malformed progress', () => {
  const valid = { employeeId: 1, title: 'Quality', start_date: '2026-01-01', end_date: '2026-12-31' };
  assert.equal(legacyGoalCreate.safeParse(valid).success, true);
  for (const extra of [{ title: ' ' }, { end_date: '2025-01-01' }, { target_value: Infinity }, { status: 'APPROVED' }])
    assert.equal(legacyGoalCreate.safeParse({ ...valid, ...extra }).success, false);
  for (const progress of [null, '', true, '75', -1, 101, NaN, Infinity])
    assert.equal(legacyGoalProgress.safeParse({ goalId: 1, progress }).success, false);
  assert.equal(legacyGoalUpdate.safeParse({ expectedVersion: -1, progress: 20 }).success, false);
  assert.equal(legacyGoalProgress.parse({ goalId: '1', progress: 0 }).progress, 0);
});

test('alignment normalizes identifiers before rejecting self edges', () => {
  assert.equal(legacyGoalAlignment.safeParse({ parentGoalId: '1', alignedGoalId: 1 }).success, false);
  assert.deepEqual(legacyGoalAlignment.parse({ parentGoalId: '1', alignedGoalId: '2' }),
    { parentGoalId: 1, alignedGoalId: 2 });
});

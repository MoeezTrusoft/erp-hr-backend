import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, company, people, db, fixture, submit, act, setup } from './fixtures.mjs';

test('legacy appraisal approvals bind scored items and feedback and freeze final evidence', { timeout: 120000 }, async () => {
  await setup();
  const s = await fixture('PERFORMANCE');
  const metric = await db(tx => tx.performanceMetric.create({ data: { tenantId: company, name: 'Quality ' + randomUUID() } }));
  const item = await db(tx => tx.performanceReviewItem.create({ data: { tenantId: company,
    reviewId: s.row.id, metricId: metric.id, rating: 3, comment: 'Original evidence' } }));
  const feedback = await db(tx => tx.reviewFeedback.create({ data: { tenantId: company,
    reviewId: s.row.id, reviewerId: people.MANAGER.id, feedback: 'Observed delivery', rating: 3 } }));
  let row = await submit(s);
  await db(tx => tx.performanceReviewItem.update({ where: { id: item.id }, data: { rating: 4 } }));
  await assert.rejects(act('MANAGER', row, 'RECOMMEND_APPROVAL'), /evidence changed/);
  row = await act('MANAGER', row, 'REVERT');
  row = await submit(s, row.version);
  await db(tx => tx.reviewFeedback.update({ where: { id: feedback.id }, data: { feedback: 'Changed evidence' } }));
  await assert.rejects(act('MANAGER', row, 'RECOMMEND_APPROVAL'), /evidence changed/);
  row = await act('MANAGER', row, 'REVERT');
  row = await submit(s, row.version);
  row = await act('MANAGER', row, 'RECOMMEND_APPROVAL');
  row = await act('HR', row, 'VERIFY');
  const requestKey = randomUUID();
  const before = row;
  row = await act('MANAGEMENT', before, 'APPROVE', { requestKey });
  const replay = await act('MANAGEMENT', before, 'APPROVE', { requestKey });
  assert.equal(row.stage, 'APPROVED');
  assert.equal(replay.approvalRef, row.approvalRef);
  for (const change of [
    tx => tx.performanceReviewItem.update({ where: { id: item.id }, data: { rating: 2 } }),
    tx => tx.performanceReviewItem.delete({ where: { id: item.id } }),
    tx => tx.reviewFeedback.update({ where: { id: feedback.id }, data: { rating: 2 } }),
    tx => tx.reviewFeedback.create({ data: { tenantId: company, reviewId: s.row.id,
      reviewerId: people.MANAGER.id, feedback: 'Late alteration' } }),
  ]) await assert.rejects(db(change), /Finalized appraisal evidence is immutable/);
  const events = await db(tx => tx.outboxEvent.findMany({ where: { tenantId: company,
    aggregateId: String(s.row.id), aggregateType: 'PerformanceReview' } }));
  assert.equal(events.filter(event => event.eventName === 'hr.performance.review_finalized.v1').length, 1);
});
test.after(() => prisma.$disconnect());

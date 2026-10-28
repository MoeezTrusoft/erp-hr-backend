import assert from "node:assert/strict";
import {
  createPerformanceTemplate,
  updatePerformanceTemplate,
} from "../../src/services/performanceTemplateService.js";
import { createPerformanceCycle } from "../../src/services/performanceCycleService.js";
import {
  initiateReviewsService,
  submitReviewService,
} from "../../src/services/performanceReview.service.js";
import { adjustRatingService } from "../../src/services/calibration.service.js";
import { getCycleComparisonService } from "../../src/services/calibrationReport.service.js";
import {
  createGoalService,
  addGoalProgressService,
} from "../../src/services/goal.service.js";
import { createGoalAlignmentService } from "../../src/services/goalAlignment.service.js";
import { addFeedback } from "../../src/services/performance.service.js";
import { runReviewReminderJob } from "../../src/services/reminderScheduler.service.js";
import { createMetric, upsertReviewItems, getReviewItems } from "../../src/services/performanceMetricService.js";
import { upsertReviewItems as replaceItemsController } from "../../src/controllers/performanceMetricController.js";

export async function legacyRegressions(
  t,
  { as, tenant, other, people, db, admin },
) {
  let cycle, review;
  await t.test('Legacy cycle and template configuration rejects mass assignment and invalid calendar dates before writing', async () => {
    const before = await db(async tx => ({ templates: await tx.performanceTemplate.count(), cycles: await tx.performanceCycle.count() }));
    for (const payload of [{ name: ' ' }, { name: 'Template', criteria: [' '] },
      { name: 'Template', createdById: people.HR.id }, { name: 'Template', overall_rating: 6 }]) {
      await assert.rejects(as('HR', () => createPerformanceTemplate({ ...payload, tenantId: tenant }, people.HR.id)), e => e.name === 'ZodError');
    }
    const valid = { name: 'Cycle', templateId: 1, start_date: '2026-01-01', end_date: '2026-12-31' };
    for (const payload of [{ ...valid, start_date: '2026-02-30' }, { ...valid, end_date: '2025-12-31' },
      { ...valid, status: 'COMPLETED' }, { ...valid, reviews: { create: {} } }, { ...valid, templateId: true }]) {
      await assert.rejects(as('HR', () => createPerformanceCycle({ ...payload, tenantId: tenant }, people.HR.id)), e => e.name === 'ZodError');
    }
    const after = await db(async tx => ({ templates: await tx.performanceTemplate.count(), cycles: await tx.performanceCycle.count() }));
    assert.deepEqual(after, before);
  });
  await t.test(
    "Legacy Prisma writes preserve criteria, valid fields and launch retry counts",
    async () => {
      const template = await as("HR", () =>
        createPerformanceTemplate(
          {
            tenantId: tenant,
            name: "Legacy " + tenant,
            criteria: ["Quality", "Delivery"],
          },
          people.HR.id,
        ),
      );
      assert.deepEqual(template.criteria, ["Quality", "Delivery"]);
      cycle = await as("HR", () =>
        createPerformanceCycle(
          {
            tenantId: tenant,
            name: "Legacy " + tenant,
            templateId: template.id,
            start_date: "2025-01-01",
            end_date: "2025-12-31",
          },
          people.HR.id,
        ),
      );
      const first = await as("HR", () =>
        initiateReviewsService(
          cycle.id,
          [people.EMPLOYEE.id],
          people.HR.id,
          tenant,
        ),
      );
      const replay = await as("HR", () =>
        initiateReviewsService(
          cycle.id,
          [people.EMPLOYEE.id],
          people.HR.id,
          tenant,
        ),
      );
      assert.equal(first.count, 1);
      assert.equal(replay.count, 0);
      review = await db((tx) =>
        tx.performanceReview.findFirst({
          where: { tenantId: tenant, cycleId: cycle.id },
        }),
      );
      await assert.rejects(
        as("HR", () =>
          updatePerformanceTemplate(
            template.id,
            { criteria: ["Changed"] },
            people.HR.id,
            tenant,
          ),
        ),
        (e) => e.status === 409,
      );
      const feedback = await as("MANAGER", () =>
        addFeedback(
          {
            reviewId: review.id,
            reviewerId: people.MANAGER.id,
            feedback: "Zero is a recorded value",
            rating: 0,
          },
          people.MANAGER.id,
          tenant,
        ),
      );
      assert.equal(feedback.rating, 0);
      assert.equal(feedback.reviewId, review.id);
    },
  );
  await t.test('Legacy item replacement rejects malformed REST payloads without erasing saved evidence', async () => {
    const metric = await as('HR', () => createMetric({ tenantId: tenant, name: 'Quality' }));
    const valid = [{ metricId: metric.id, rating: 4, comment: 'Saved evidence' }];
    await as('HR', () => upsertReviewItems({ reviewId: review.id, tenantId: tenant, items: valid }));
    for (const body of [{}, { items: null }, { items: 'invalid' }, { items: {} },
      { items: [{ ...valid[0], rating: 6 }] }, { items: [{ ...valid[0], rating: '4' }] },
      { items: [valid[0], valid[0]] }, { items: [{ ...valid[0], tenantId: other }] },
      { items: [], unexpected: true }]) {
      let status;
      const res = { status(value) { status = value; return this; }, json() { return this; } };
      await as('HR', () => replaceItemsController({ user: { tenantId: tenant }, params: { reviewId: String(review.id) }, body }, res));
      assert.equal(status, 400);
      const stored = await as('HR', () => getReviewItems({ reviewId: review.id, tenantId: tenant }));
      assert.equal(stored.length, 1);
      assert.equal(stored[0].comment, 'Saved evidence');
    }
    await assert.rejects(as('HR', () => upsertReviewItems({ reviewId: review.id, tenantId: tenant })), /items/);
    await assert.rejects(as('HR', () => upsertReviewItems({ reviewId: review.id, tenantId: other, items: [] }), undefined, other));
    await as('HR', () => upsertReviewItems({ reviewId: review.id, tenantId: tenant, items: [] }));
    assert.equal((await as('HR', () => getReviewItems({ reviewId: review.id, tenantId: tenant }))).length, 0);
  });
  await t.test('Concurrent legacy metric replacements remain whole and failed inserts retain prior evidence', async () => {
    const metrics = await Promise.all(['Delivery', 'Accuracy'].map(name => as('HR', () => createMetric({ tenantId: tenant, name }))));
    const replace = items => as('HR', () => upsertReviewItems({ reviewId: review.id, tenantId: tenant, items }));
    await Promise.all(metrics.map(metric => replace([{ metricId: metric.id, rating: 3 }])));
    const saved = await as('HR', () => getReviewItems({ reviewId: review.id, tenantId: tenant }));
    assert.equal(saved.length, 1, 'Concurrent replacements must not merge their item lists');
    await admin.query(`CREATE FUNCTION appraisal_test_fail_items() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tenantId"='${tenant}'::uuid THEN RAISE EXCEPTION 'simulated item failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER appraisal_test_fail_items BEFORE INSERT ON "PerformanceReviewItem" FOR EACH ROW EXECUTE FUNCTION appraisal_test_fail_items()`);
    try {
      await assert.rejects(replace([{ metricId: metrics[0].id, rating: 5 }]), /simulated item failure/);
      const after = await as('HR', () => getReviewItems({ reviewId: review.id, tenantId: tenant }));
      assert.equal(after.length, 1);
      assert.equal(after[0].id, saved[0].id);
      assert.equal(after[0].rating, saved[0].rating);
    } finally {
      await admin.query('DROP TRIGGER appraisal_test_fail_items ON "PerformanceReviewItem"; DROP FUNCTION appraisal_test_fail_items()');
    }
  });
  await t.test(
    "Legacy submission rolls back edited content when approval validation fails",
    async () => {
      await db((tx) =>
        tx.employee.update({
          where: { id: people.EMPLOYEE.id },
          data: { managerId: people.EMPLOYEE.id },
        }),
      );
      try {
        await assert.rejects(
          as(
            "EMPLOYEE",
            () =>
              submitReviewService(
                review.id,
                { comments: "Must roll back", overall_rating: 3 },
                people.EMPLOYEE.id,
                tenant,
              ),
            ["hr.approvals.self"],
          ),
          /independent line manager/,
        );
        const after = await db((tx) =>
          tx.performanceReview.findFirst({ where: { id: review.id } }),
        );
        assert.equal(after.comments, review.comments);
        assert.equal(after.overall_rating, review.overall_rating);
      } finally {
        await db((tx) =>
          tx.employee.update({
            where: { id: people.EMPLOYEE.id },
            data: { managerId: people.MANAGER.id },
          }),
        );
      }
    },
  );
  await t.test(
    "Legacy calibration keeps the adjustment, rating and event atomic; comparison uses the same cohort",
    async () => {
      const session = await db((tx) =>
        tx.calibrationSession.create({
          data: { tenantId: tenant, name: "Calibration", cycleId: cycle.id },
        }),
      );
      await db((tx) =>
        tx.performanceReview.update({
          where: { id: review.id },
          data: { overall_rating: 0 },
        }),
      );
      const input = {
        reviewId: review.id,
        calibrationSessionId: session.id,
        old_rating: 0,
        new_rating: 4,
        justification: "Evidence reviewed",
      };
      await assert.rejects(
        as("MANAGER", () => adjustRatingService(input, people.HR.id, tenant)),
        (e) => e.status === 403,
      );
      await admin.query(
        `CREATE FUNCTION appraisal_test_fail_calibration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tenantId"='${tenant}'::uuid AND NEW."eventName"='hr.performance.legacy_calibrated.v1' THEN RAISE EXCEPTION 'simulated outbox failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER appraisal_test_fail_calibration BEFORE INSERT ON "outbox_events" FOR EACH ROW EXECUTE FUNCTION appraisal_test_fail_calibration()`,
      );
      try {
        await assert.rejects(
          as("HR", () => adjustRatingService(input, people.HR.id, tenant)),
          /simulated outbox failure/,
        );
        assert.equal(
          (
            await db((tx) =>
              tx.performanceReview.findFirst({ where: { id: review.id } }),
            )
          ).overall_rating,
          0,
        );
        assert.equal(
          await db((tx) =>
            tx.ratingAdjustment.count({ where: { reviewId: review.id } }),
          ),
          0,
        );
      } finally {
        await admin.query(
          'DROP TRIGGER appraisal_test_fail_calibration ON "outbox_events"; DROP FUNCTION appraisal_test_fail_calibration()',
        );
      }
      const result = await as("HR", () =>
        adjustRatingService(input, people.MANAGER.id, tenant),
      );
      assert.equal(result.calibrated_by_employee_id, people.HR.id);
      assert.equal(result.calibrationSessionId, session.id);
      await as("HR", () =>
        adjustRatingService(
          { ...input, old_rating: 4, new_rating: 3 },
          people.HR.id,
          tenant,
        ),
      );
      const comparison = await as("HR", () =>
        getCycleComparisonService(cycle.id, tenant),
      );
      assert.equal(comparison.calibratedReviews, 1);
      assert.equal(comparison.avgBefore, 0);
      assert.equal(comparison.avgAfter, 3);
      assert.equal(comparison.improvement, 3);
      await assert.rejects(
        as("HR", () => adjustRatingService(input, people.HR.id, tenant)),
        (e) => e.status === 412,
      );
    },
  );
  await t.test(
    "Legacy goal progress rolls back its parent update when the journal insert fails",
    async () => {
      const goal = await as("HR", () =>
        createGoalService(
          {
            employeeId: people.EMPLOYEE.id,
            title: "Retain zero target",
            start_date: "2026-01-01",
            end_date: "2026-12-31",
            target_value: 0,
          },
          people.HR.id,
          tenant,
        ),
      );
      assert.equal(goal.target_value, 0);
      await assert.rejects(
        as("HR", () =>
          addGoalProgressService(
            { goalId: goal.id, progress: 40, comment: "Must roll back" },
            2147483647,
            tenant,
          ),
        ),
      );
      const after = await db((tx) =>
        tx.goal.findFirst({ where: { id: goal.id } }),
      );
      assert.equal(after.progress, goal.progress);
      assert.equal(after.version, goal.version);
      const progress = await as("HR", () =>
        addGoalProgressService(
          { goalId: goal.id, progress: 40, comment: "Recorded atomically" },
          people.HR.id,
          tenant,
        ),
      );
      assert.equal(progress.progress, 40);
    },
  );
  await t.test(
    "Legacy alignment rejects a transitive cycle and concurrent inverse edge",
    async () => {
      const goals = [];
      for (let n = 0; n < 5; n++)
        goals.push(
          await as("HR", () =>
            createGoalService(
              {
                employeeId: people.EMPLOYEE.id,
                title: "Alignment " + n,
                start_date: "2026-01-01",
                end_date: "2026-12-31",
              },
              people.HR.id,
              tenant,
            ),
          ),
        );
      const align = (parent, child) =>
        as("HR", () =>
          createGoalAlignmentService(
            {
              tenantId: tenant,
              parentGoalId: goals[parent].id,
              alignedGoalId: goals[child].id,
            },
            people.HR.id,
          ),
        );
      await align(0, 1);
      await align(1, 2);
      await assert.rejects(align(2, 0), (e) => e.status === 409);
      await assert.rejects(align(0, 1), (e) => e.status === 409);
      const race = await Promise.allSettled([align(3, 4), align(4, 3)]);
      assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(
        race.find((x) => x.status === "rejected").reason.status,
        409,
      );
    },
  );
  await t.test(
    "Legacy due reminder sweep uses real enums, explicit tenant scope and daily deduplication",
    async () => {
      const first = await runReviewReminderJob({
        tenantIds: [tenant],
        now: new Date("2026-10-26T09:00:00Z"),
      });
      const second = await runReviewReminderJob({
        tenantIds: [tenant],
        now: new Date("2026-10-26T09:01:00Z"),
      });
      assert.equal(first.created, 1);
      assert.equal(second.created, 0);
      assert.equal(
        (await runReviewReminderJob({ tenantIds: [other] })).created,
        0,
      );
      const reminder = await db((tx) =>
        tx.reviewReminder.findFirst({ where: { reviewId: review.id } }),
      );
      assert.equal(reminder.tenantId, tenant);
      assert.equal(reminder.sentToId, people.EMPLOYEE.id);
    },
  );
}

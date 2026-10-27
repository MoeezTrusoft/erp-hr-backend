// tests/performance/workflow.postgres.test.mjs — PERF-P0 (E-06).
//
// The legacy performance-appraisal services against the isolated local HR
// test database (prepared by tests/separation/prepare.mjs --reset, which also
// installs the approval guard triggers). Covers the Phase-0 defects D1..D17:
// review create / bulk initiate / feedback / goal progress / alignment cycles /
// calibration adjustments / reports / cycle and template lifecycle, plus the
// E-02 guard (FINALIZED only through the Approval Centre) and the E-03 event.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  prisma,
  company,
  other,
  people,
  db,
  setup,
} from "../approval/fixtures.mjs";
import { completeBusinessApproval } from "../approval/complete.mjs";

const { mcpCtx } = await import("../../src/mcp/context.js");
const perf = await import("../../src/services/performance.service.js");
const reviews = await import("../../src/services/performanceReview.service.js");
const calibration = await import("../../src/services/calibration.service.js");
const reports = await import("../../src/services/calibrationReport.service.js");
const goals = await import("../../src/services/goal.service.js");
const alignment = await import("../../src/services/goalAlignment.service.js");
const cycles = await import("../../src/services/performanceCycleService.js");
const templates = await import("../../src/services/performanceTemplateService.js");
const { runReviewReminderJob } = await import("../../src/services/reminderScheduler.service.js");

// Run a service call as an HR actor of `tenantId` (the structural tenant
// extension and tenantTransaction both read this context).
const inTenant = (fn, tenantId = company) =>
  mcpCtx.run(
    {
      actorVerified: true,
      user: { tenantId, userId: people.HR?.userId, employeeId: people.HR?.id, isAdmin: true },
      permissions: [],
    },
    fn,
  );
const asSystem = (fn) => mcpCtx.run({ system: true }, fn);
const status = (e) => e?.status ?? e?.statusCode;

test("PERF-P0 legacy performance services against PostgreSQL", { timeout: 120000 }, async (t) => {
  await setup();
  const hr = () => people.HR.id;
  const cycleName = "FY" + randomUUID().slice(0, 8);
  let template, cycle, review, goalA, goalB, goalC, session;

  await t.test("template persists criteria and validates weights (D13 / E-04)", async () => {
    await assert.rejects(
      inTenant(() =>
        templates.createPerformanceTemplate(
          { name: "bad", criteria: [{ name: "Goals", weight: 60 }, { name: "Values", weight: 30 }] },
          hr(),
          company,
        ),
      ),
      (e) => status(e) === 400 && e.code === "HR-4000",
    );
    template = await inTenant(() =>
      templates.createPerformanceTemplate(
        {
          name: "Standard " + cycleName,
          criteria: [{ name: "Goals", weight: 60 }, { name: "Competencies", weight: 40 }],
        },
        hr(),
        company,
      ),
    );
    assert.equal(template.criteria.length, 2);
    await assert.rejects(
      inTenant(() => templates.updatePerformanceTemplate(template.id, { surprise: 1 }, hr(), company)),
      (e) => status(e) === 400,
    );
  });

  await t.test("cycle accepts the MCP tool's camelCase payload and guards transitions (D11 / D12)", async () => {
    cycle = await inTenant(() =>
      cycles.createPerformanceCycle(
        { name: cycleName, startDate: "2026-01-01", endDate: "2026-12-31", templateId: template.id },
        hr(),
        company,
      ),
    );
    assert.equal(cycle.status, "DRAFT");
    assert.equal(cycle.templateId, template.id);
    await assert.rejects(
      inTenant(() => cycles.updatePerformanceCycle(cycle.id, { status: "CLOSED" }, hr(), company)),
      (e) => status(e) === 409,
    );
    await assert.rejects(
      inTenant(() => cycles.updatePerformanceCycle(cycle.id, { tenantId: other }, hr(), company)),
      (e) => status(e) === 400,
    );
    cycle = await inTenant(() => cycles.updatePerformanceCycle(cycle.id, { status: "ACTIVE" }, hr(), company));
    assert.equal(cycle.status, "ACTIVE");
    await assert.rejects(
      inTenant(() => cycles.deletePerformanceCycle(cycle.id, hr(), company)),
      (e) => status(e) === 409,
    );
    // The template is referenced by an open cycle: archiving it is refused.
    await assert.rejects(
      inTenant(() => templates.deletePerformanceTemplate(template.id, hr(), company)),
      (e) => status(e) === 409,
    );
  });

  await t.test("bulk initiate is idempotent and tenant-bound (D2 / E-05)", async () => {
    const ids = [people.EMPLOYEE.id, people.OTHER.id];
    const first = await inTenant(() => reviews.initiateReviewsService(cycle.id, ids, hr(), company));
    assert.deepEqual([first.count, first.skipped], [2, 0]);
    const again = await inTenant(() => reviews.initiateReviewsService(cycle.id, ids, hr(), company));
    assert.deepEqual([again.count, again.skipped], [0, 2]);
    const rows = await db((tx) => tx.performanceReview.findMany({ where: { cycleId: cycle.id } }));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.tenantId === company && r.status === "DRAFT" && r.period_start));
    await assert.rejects(
      inTenant(() => reviews.initiateReviewsService(cycle.id, [999999999], hr(), company)),
      (e) => status(e) === 404,
    );
    // The DB unique index backs the service check.
    await assert.rejects(
      db((tx) =>
        tx.performanceReview.create({
          data: { tenantId: company, employeeId: people.EMPLOYEE.id, cycleId: cycle.id, type: "SELF" },
        }),
      ),
      (e) => e.code === "P2002",
    );
  });

  await t.test("review create works and rejects a duplicate (D1)", async () => {
    review = await inTenant(() =>
      perf.createPerformanceReview(
        {
          employeeId: people.EMPLOYEE.id,
          reviewerId: people.MANAGER.id,
          cycleId: cycle.id,
          period_start: "2026-01-01",
          period_end: "2026-06-30",
          reviewType: "MANAGER",
          comments: "Mid-year",
        },
        hr(),
        company,
      ),
    );
    assert.equal(review.type, "MANAGER");
    await assert.rejects(
      inTenant(() =>
        perf.createPerformanceReview(
          {
            employeeId: people.EMPLOYEE.id,
            reviewerId: people.MANAGER.id,
            cycleId: cycle.id,
            period_start: "2026-01-01",
            period_end: "2026-06-30",
            reviewType: "MANAGER",
          },
          hr(),
          company,
        ),
      ),
      (e) => status(e) === 409,
    );
    await assert.rejects(
      inTenant(() =>
        perf.createPerformanceReview(
          { employeeId: people.EMPLOYEE.id, period_start: "2026-06-30", period_end: "2026-01-01" },
          hr(),
          company,
        ),
      ),
      (e) => status(e) === 400,
    );
  });

  await t.test("cross-tenant probe reads nothing and the list paginates at the database (D17)", async () => {
    const foreign = await inTenant(() => perf.getAllReviews(other, { page: 1, limit: 10 }), other);
    assert.equal(foreign.total, 0);
    const page = await inTenant(() => perf.getAllReviews(company, { page: 1, limit: 2, cycleId: cycle.id }));
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 3);
    const page2 = await inTenant(() => perf.getAllReviews(company, { page: 2, limit: 2, cycleId: cycle.id }));
    assert.equal(page2.items.length, 1);
    await assert.rejects(
      inTenant(() => perf.updateReview(review.id, { comments: "x" }, hr(), other), other),
      (e) => status(e) === 404,
    );
  });

  await t.test("feedback attaches to a review (D5) and a missing rating keeps the stored one", async () => {
    const fb = await inTenant(() =>
      perf.addFeedback({ reviewId: review.id, reviewerId: people.MANAGER.id, feedback: "Solid", rating: 4 }, hr(), company),
    );
    assert.equal(fb.reviewId, review.id);
    const updated = await inTenant(() => perf.updateFeedback(fb.id, { feedback: "Solid, improving" }, hr(), company));
    assert.equal(updated.rating, 4);
    await assert.rejects(
      inTenant(() => perf.addFeedback({ reviewId: 999999999, reviewerId: people.MANAGER.id, feedback: "x" }, hr(), company)),
      (e) => status(e) === 404,
    );
  });

  await t.test("status cannot be set outside the Approval Centre (E-02 / D4)", async () => {
    await assert.rejects(
      inTenant(() => perf.updateReview(review.id, { status: "FINALIZED" }, hr(), company)),
      (e) => status(e) === 400,
    );
    const rated = await inTenant(() => perf.updateReview(review.id, { overallRating: 3.5 }, hr(), company));
    assert.equal(rated.overall_rating, 3.5);
    // A direct FINALIZED write (any client, any ORM path) is rejected by the
    // hr_approval_guard trigger (migration 20261015120000) with HR-4201.
    await assert.rejects(
      db((tx) => tx.performanceReview.update({ where: { id: review.id }, data: { status: "FINALIZED" } })),
      (e) => /HR-4201/.test(e.message),
    );
    const still = await db((tx) => tx.performanceReview.findUnique({ where: { id: review.id } }));
    assert.equal(still.status, "IN_PROGRESS");
  });

  await t.test("the Approval Centre finalizes and emits hr.performance.review_finalized.v1 (E-03)", async () => {
    const record = await completeBusinessApproval(prisma, company, "PERFORMANCE", review.id);
    assert.equal(record.stage, "APPROVED");
    const finalized = await db((tx) => tx.performanceReview.findUnique({ where: { id: review.id } }));
    assert.equal(finalized.status, "FINALIZED");
    const events = await db((tx) =>
      tx.outboxEvent.findMany({
        where: { tenantId: company, eventName: "hr.performance.review_finalized.v1", aggregateId: String(review.id) },
      }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.payload.rating, 3.5);
    assert.equal(events[0].payload.payload.employeeId, String(people.EMPLOYEE.id));
    // A finalized review is immutable through the service too.
    await assert.rejects(
      inTenant(() => perf.updateReview(review.id, { comments: "late edit" }, hr(), company)),
      (e) => status(e) === 409,
    );
  });

  await t.test("calibration adjusts atomically, rejects a stale old_rating and links the session (D6)", async () => {
    const target = await db((tx) =>
      tx.performanceReview.findFirst({ where: { cycleId: cycle.id, employeeId: people.OTHER.id } }),
    );
    await inTenant(() => perf.updateReview(target.id, { overallRating: 2 }, hr(), company));
    await assert.rejects(
      inTenant(() =>
        calibration.adjustRatingService({ reviewId: target.id, old_rating: 2, new_rating: 3 }, hr(), company),
      ),
      (e) => status(e) === 404, // no open session yet
    );
    session = await inTenant(() =>
      calibration.createCalibrationSessionService({ name: "Cal " + cycleName, cycleId: cycle.id }, hr(), company),
    );
    await assert.rejects(
      inTenant(() =>
        calibration.adjustRatingService({ reviewId: target.id, old_rating: 4, new_rating: 3 }, hr(), company),
      ),
      (e) => status(e) === 409,
    );
    const adj = await inTenant(() =>
      calibration.adjustRatingService(
        { reviewId: target.id, old_rating: 2, new_rating: 3, justification: "Cohort comparison" },
        hr(),
        company,
      ),
    );
    assert.equal(adj.calibrationSessionId, session.id);
    const after = await db((tx) => tx.performanceReview.findUnique({ where: { id: target.id } }));
    assert.equal(after.overall_rating, 3);
    assert.equal(after.calibrationSessionId, session.id);
    // A finalized review cannot be calibrated.
    await assert.rejects(
      inTenant(() =>
        calibration.adjustRatingService({ reviewId: review.id, old_rating: 3.5, new_rating: 4 }, hr(), company),
      ),
      (e) => status(e) === 409,
    );
    await inTenant(() => calibration.finalizeCalibrationService(session.id, hr(), company));
    await assert.rejects(
      inTenant(() => calibration.finalizeCalibrationService(session.id, hr(), company)),
      (e) => status(e) === 409,
    );
  });

  await t.test("calibration reports compute before/after from the review rows (D7)", async () => {
    const overview = await inTenant(() => reports.getCalibrationOverviewService(company));
    assert.equal(overview.adjustedReviews, 1);
    assert.ok(overview.totalReviews >= 2);
    const cmp = await inTenant(() => reports.getCycleComparisonService(cycle.id, company));
    assert.equal(cmp.calibratedReviews, 1);
    // before: 3.5 (unadjusted) and 2 (first old_rating); after: 3.5 and 3.
    assert.equal(cmp.avgBefore, 2.75);
    assert.equal(cmp.avgAfter, 3.25);
    assert.equal(cmp.improvement, 0.5);
    const byDept = await inTenant(() => reports.getAverageByDepartmentService(company));
    assert.ok(Array.isArray(byDept) && byDept.length >= 1);
    const byMgr = await inTenant(() => reports.getAverageByManagerService(company));
    assert.ok(byMgr.some((r) => r.managerId === people.MANAGER.id));
  });

  await t.test("goal progress is a percent and the note + goal update are atomic (D8 / D9)", async () => {
    goalA = await inTenant(() =>
      goals.createGoalService(
        { employeeId: people.EMPLOYEE.id, title: "A", start_date: "2026-01-01", end_date: "2026-12-31", target_value: 200 },
        hr(),
        company,
      ),
    );
    const updated = await inTenant(() => goals.updateGoalService(goalA.id, { progress: 25 }, hr(), company));
    assert.equal(updated.progress, 25);
    assert.equal(updated.current_value, 50);
    assert.equal(updated.version, goalA.version + 1);
    await assert.rejects(
      inTenant(() => goals.updateGoalService(goalA.id, { progress: 30, expectedVersion: goalA.version }, hr(), company)),
      (e) => status(e) === 412,
    );
    const note = await inTenant(() =>
      goals.addGoalProgressService({ goalId: goalA.id, progress: 60, comment: "Halfway" }, hr(), company),
    );
    assert.equal(note.progress, 60);
    const fresh = await db((tx) => tx.goal.findUnique({ where: { id: goalA.id } }));
    assert.equal(fresh.progress, 60);
    assert.equal(fresh.current_value, 120);
    await assert.rejects(
      inTenant(() => goals.addGoalProgressService({ goalId: goalA.id, progress: 140 }, hr(), company)),
      (e) => status(e) === 400,
    );
    await assert.rejects(
      inTenant(() => goals.updateGoalService(goalA.id, { status: "APPROVED" }, hr(), company)),
      (e) => status(e) === 409,
    );
  });

  await t.test("alignment rejects cycles and duplicates, archives instead of deleting (D10 / E-05)", async () => {
    const mk = (title) =>
      inTenant(() =>
        goals.createGoalService(
          { employeeId: people.EMPLOYEE.id, title, start_date: "2026-01-01", end_date: "2026-12-31" },
          hr(),
          company,
        ),
      );
    goalB = await mk("B");
    goalC = await mk("C");
    const ab = await inTenant(() =>
      alignment.createGoalAlignmentService({ parentGoalId: goalA.id, alignedGoalId: goalB.id }, hr(), company),
    );
    await inTenant(() =>
      alignment.createGoalAlignmentService({ parentGoalId: goalB.id, alignedGoalId: goalC.id }, hr(), company),
    );
    await assert.rejects(
      inTenant(() =>
        alignment.createGoalAlignmentService({ parentGoalId: goalC.id, alignedGoalId: goalA.id }, hr(), company),
      ),
      (e) => status(e) === 409 && /cycle/i.test(e.message),
    );
    await assert.rejects(
      inTenant(() =>
        alignment.createGoalAlignmentService({ parentGoalId: goalA.id, alignedGoalId: goalB.id }, hr(), company),
      ),
      (e) => status(e) === 409 && /already/i.test(e.message),
    );
    await assert.rejects(
      inTenant(() =>
        alignment.createGoalAlignmentService({ parentGoalId: goalA.id, alignedGoalId: goalA.id }, hr(), company),
      ),
      (e) => status(e) === 400,
    );
    const removed = await inTenant(() => alignment.deleteGoalAlignmentService(ab.id, hr(), company));
    assert.ok(removed.archivedAt);
    const visible = await inTenant(() => alignment.getGoalAlignmentsService(goalA.id, company));
    assert.equal(visible.length, 0);
    // Re-aligning re-activates the archived edge (unique index intact).
    const again = await inTenant(() =>
      alignment.createGoalAlignmentService({ parentGoalId: goalA.id, alignedGoalId: goalB.id }, hr(), company),
    );
    assert.equal(again.id, ab.id);
    assert.equal(again.archivedAt, null);
  });

  await t.test("reminder job is set-based, tenant-stamped and idempotent per day (D14)", async () => {
    const before = await db((tx) => tx.reviewReminder.count({ where: { tenantId: company } }));
    const run1 = await asSystem(() => runReviewReminderJob());
    assert.ok(run1.scanned >= 1);
    assert.ok(run1.created >= 1);
    // The sweep is fleet-wide (SYSTEM context), so other tenants' open reviews in
    // the shared test database count towards `created`; this tenant's rows are
    // the two open cycle reviews (the third is FINALIZED).
    const mine = await db((tx) => tx.reviewReminder.findMany({ where: { tenantId: company } }));
    assert.equal(mine.length - before, 2);
    assert.ok(run1.created >= 2);
    assert.ok(mine.every((r) => r.tenantId === company));
    const run2 = await asSystem(() => runReviewReminderJob());
    assert.equal(run2.created, 0);
    // Manual reminder de-duplicates within the day too.
    const manual = await inTenant(() =>
      reviews.sendReviewReminderService(review.id, people.EMPLOYEE.id, "FEEDBACK_REQUEST", hr(), company),
    ).catch((e) => e);
    assert.equal(status(manual), 409); // review is FINALIZED
  });

  await t.test("cycle close and archive", async () => {
    cycle = await inTenant(() => cycles.updatePerformanceCycle(cycle.id, { status: "CLOSED" }, hr(), company));
    assert.equal(cycle.status, "CLOSED");
    await assert.rejects(
      inTenant(() => cycles.updatePerformanceCycle(cycle.id, { status: "ACTIVE" }, hr(), company)),
      (e) => status(e) === 409,
    );
    await assert.rejects(
      inTenant(() => reviews.initiateReviewsService(cycle.id, [people.MANAGER.id], hr(), company)),
      (e) => status(e) === 409,
    );
    const archived = await inTenant(() => cycles.deletePerformanceCycle(cycle.id, hr(), company));
    assert.ok(archived.archivedAt);
    const listed = await inTenant(() => cycles.getAllPerformanceCycles(company));
    assert.ok(!listed.some((c) => c.id === cycle.id));
    const stillThere = await db((tx) => tx.performanceReview.count({ where: { cycleId: cycle.id } }));
    assert.equal(stillThere, 3);
    const tpl = await inTenant(() => templates.deletePerformanceTemplate(template.id, hr(), company));
    assert.ok(tpl.archivedAt);
  });
});

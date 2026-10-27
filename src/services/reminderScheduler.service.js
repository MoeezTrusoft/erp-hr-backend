// src/services/reminderScheduler.service.js
//
// BE-§9.4 (WBS-MODULES §M1): the node-cron scheduler is RETIRED. The job
// BODIES live here as plain, reusable async processors; the SCHEDULING is owned
// by BullMQ (src/jobs/reminder.queue.js) which gives a retry ladder, a DLQ, and
// repeatable de-dup that bare cron cannot. These processors are pure of any
// timer wiring so they are unit-testable and can be invoked from a BullMQ
// worker, a one-shot script, or a request.
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { generateDocumentExpiryAlerts } from "./documentExpiryAlert.service.js";

const reminderLog = logger.child({ component: "reminder-jobs" });

/**
 * Performance review reminder sweep (was the 9 AM cron). Creates one
 * PENDING_REVIEW reminder row per open review per day.
 *
 * PERF-P0 (E-01 / D14): the sweep used to filter `status in [PENDING, …]`
 * (PENDING is not a ReviewStatus, so Prisma rejected the query), ran one
 * findFirst per review (N+1) and stamped no tenant on the rows it created.
 * It now selects open reviews (DRAFT / IN_PROGRESS) that still have an
 * employee, reads today's reminders in one query, and inserts the missing
 * rows in one createMany with each review's own tenantId — the job runs in
 * the SYSTEM context, so nothing injects the tenant for it.
 * @returns {Promise<{ scanned: number, created: number }>}
 */
export async function runReviewReminderJob({ now = new Date() } = {}) {
  reminderLog.info("performance review reminder job: start");

  const pendingReviews = await prisma.performanceReview.findMany({
    where: { status: { in: ["DRAFT", "IN_PROGRESS"] }, employeeId: { not: null } },
    select: { id: true, employeeId: true, tenantId: true },
  });
  if (pendingReviews.length === 0) {
    reminderLog.info({ scanned: 0, created: 0 }, "performance review reminder job: done");
    return { scanned: 0, created: 0 };
  }

  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sentToday = await prisma.reviewReminder.findMany({
    where: {
      type: "PENDING_REVIEW",
      sentAt: { gte: startOfDay },
      reviewId: { in: pendingReviews.map((r) => r.id) },
    },
    select: { reviewId: true, sentToId: true },
  });
  const already = new Set(sentToday.map((r) => `${r.reviewId}:${r.sentToId}`));

  const data = pendingReviews
    .filter((r) => !already.has(`${r.id}:${r.employeeId}`))
    .map((r) => ({
      reviewId: r.id,
      sentToId: r.employeeId,
      type: "PENDING_REVIEW",
      tenantId: r.tenantId ?? null,
    }));

  let created = 0;
  if (data.length) {
    try {
      const result = await prisma.reviewReminder.createMany({ data });
      created = result.count;
    } catch (err) {
      reminderLog.error({ err, count: data.length }, "performance review reminder createMany failed");
    }
  }

  reminderLog.info({ scanned: pendingReviews.length, created }, "performance review reminder job: done");
  return { scanned: pendingReviews.length, created };
}

/**
 * Document-expiry alert sweep (was the 8 AM cron). Fleet-wide (no tenant) so it
 * scans every tenant's documents at the 30/14/7-day marks.
 * @returns {Promise<{ created: number }>}
 */
export async function runDocumentExpiryJob() {
  const alerts = await generateDocumentExpiryAlerts({ daysBefore: [30, 14, 7] });
  reminderLog.info({ newAlertCount: alerts.length }, "document expiry alert job: done");
  return { created: alerts.length };
}

/**
 * Retention sweep — prune stale, fully-published outbox rows past the retention
 * window so the outbox table does not grow unbounded. Bounded + idempotent: a
 * row is eligible only when publishedAt is set AND older than the window.
 * @param {object} [opts]
 * @param {number} [opts.retentionDays=30]
 * @returns {Promise<{ deleted: number }>}
 */
export async function runRetentionSweepJob({ retentionDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const writer = prisma?.outboxEvent;
  if (!writer?.deleteMany) {
    reminderLog.warn("retention sweep: OutboxEvent model unavailable — skipping");
    return { deleted: 0 };
  }
  const res = await writer.deleteMany({
    where: { publishedAt: { not: null, lt: cutoff } },
  });
  reminderLog.info({ deleted: res?.count ?? 0, retentionDays }, "retention sweep job: done");
  return { deleted: res?.count ?? 0 };
}

// Back-compat shim: the old export name. Now it just logs that scheduling has
// moved to BullMQ — it never registers a cron timer. Kept so any stale import
// does not crash a boot; the canonical entrypoint is startReminderJobs().
export const startReviewReminderScheduler = () => {
  reminderLog.warn(
    "startReviewReminderScheduler is retired — HR reminder/expiry/retention jobs are scheduled by BullMQ (src/jobs/reminder.queue.js)"
  );
};

// Compatibility scheduler entry point; the durable planner owns work dates and deadlines.
export async function runAbsenceMarkingJob() {
  const {planAttendanceFinalization,drainAttendanceFinalization}=await import('./attendanceFinalization.service.js');
  const plan=await planAttendanceFinalization();
  const result=await drainAttendanceFinalization({limit:100});
  if(plan.failures.length||result.failed)throw new Error('Attendance finalization has failed windows; durable jobs retain their work dates');
  return result;
}

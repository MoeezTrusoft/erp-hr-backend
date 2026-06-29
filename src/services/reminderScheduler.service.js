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
 * Performance review reminder sweep (was the 9 AM cron). Creates a
 * PENDING_REVIEW reminder row per pending review, idempotent within the day.
 * @returns {Promise<{ scanned: number, created: number }>}
 */
export async function runReviewReminderJob() {
  reminderLog.info("performance review reminder job: start");

  const pendingReviews = await prisma.performanceReview.findMany({
    where: { status: { in: ["PENDING", "IN_PROGRESS"] } },
    include: { employee: true, reviewer: true, cycle: true },
  });

  let created = 0;
  for (const review of pendingReviews) {
    try {
      const alreadySent = await prisma.reviewReminder.findFirst({
        where: {
          reviewId: review.id,
          sentToId: review.employeeId,
          sentAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      });

      if (alreadySent) continue;

      await prisma.reviewReminder.create({
        data: {
          reviewId: review.id,
          sentToId: review.employeeId,
          type: "PENDING_REVIEW",
        },
      });
      created += 1;
    } catch (err) {
      reminderLog.error({ err, reviewId: review.id }, "performance review reminder per-review failed");
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

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
import { markAbsences } from "./absenceMarking.service.js";

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

// HR-ATT-ABSENCE-02 (2026-09-28) — the scheduled absence-marking body. Before
// this, `markAbsences` had NO recurring caller: HR ran the MCP tool by hand and
// the September table stopped gaining ABSENT rows after Sep 15. Runs fleet-wide
// (every tenant) for YESTERDAY in Asia/Karachi — the same day-key convention as
// the self-service regularization deadline — at 03:00 PKT (22:00 UTC), when the
// previous day is complete. markAbsences' six guards (enrolled, scheduled
// working day, never overwrite, tenant-scoped, payroll-eligible, active period)
// apply unchanged; never-overwrite makes re-running a window safe, so the
// retry ladder and even a manual re-run cannot double-charge a day.
const ABSENCE_MARKING_TZ = "Asia/Karachi";

const dayKeyInMarkingTz = (when = new Date()) =>
  // en-CA formats as ISO-8601 calendar dates (YYYY-MM-DD) deterministically.
  new Intl.DateTimeFormat("en-CA", {
    timeZone: ABSENCE_MARKING_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);

/**
 * @returns {Promise<{ from: string, to: string, tenants: number, marked: number }>}
 */
export async function runAbsenceMarkingJob() {
  // Yesterday in the marking timezone: step back 24h from NOW and take that
  // instant's calendar date in the same tz (a 03:00 PKT run lands on the full
  // previous day; a late-firing retry stays on the same window).
  const day = dayKeyInMarkingTz(new Date(Date.now() - 24 * 60 * 60 * 1000));

  // There is NO Tenant model in this schema — the tenant universe is derived
  // from the Employee table (the same table markAbsences scans).
  const tenants = (
    await prisma.employee.findMany({
      where: { tenant_id: { not: null } },
      select: { tenant_id: true },
      distinct: ["tenant_id"],
      orderBy: { tenant_id: "asc" },
    })
  ).map((e) => e.tenant_id);

  let marked = 0;
  for (const tenantId of tenants) {
    try {
      // Dry run first — its summary is the audit trail of what was about to
      // be written. The write run is explicit (markAbsences defaults to
      // dryRun:true — this creates unpaid days, so writing must be asked for).
      const plan = await markAbsences({ tenantId, from: day, to: day, dryRun: true });
      const write = await markAbsences({ tenantId, from: day, to: day, dryRun: false });
      marked += write.marked;
      reminderLog.info(
        { tenantId, day, planned: plan.marked, marked: write.marked },
        "absence marking: tenant day processed"
      );
    } catch (err) {
      // One tenant failing must not stop the others; a job-level failure
      // (e.g. the tenant list itself) rides BullMQ's retry ladder.
      reminderLog.error(
        { err: { message: err?.message }, tenantId, day },
        "absence marking: tenant day failed"
      );
    }
  }

  reminderLog.info({ from: day, to: day, tenants: tenants.length, marked }, "absence marking: daily sweep done");
  return { from: day, to: day, tenants: tenants.length, marked };
}

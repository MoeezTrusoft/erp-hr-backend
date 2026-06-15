import cron from "node-cron";
import prisma from "../lib/prisma.js";
import logger from "../lib/logger.js";
import { generateDocumentExpiryAlerts } from "./documentExpiryAlert.service.js";


export const startReviewReminderScheduler = () => {
  // Performance review reminders: daily at 9 AM
  cron.schedule("0 9 * * *", async () => {
    logger.info("performance review reminder job: start");

    const pendingReviews = await prisma.performanceReview.findMany({
      where: { status: { in: ["PENDING", "IN_PROGRESS"] } },
      include: { employee: true, reviewer: true, cycle: true },
    });

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
      } catch (err) {
        logger.error({ err, reviewId: review.id }, "performance review reminder per-review failed");
      }
    }

    logger.info("performance review reminder job: done");
  });

  // Document expiry alerts: daily at 8 AM
  cron.schedule("0 8 * * *", async () => {
    try {
      const alerts = await generateDocumentExpiryAlerts({ daysBefore: [30, 14, 7] });
      logger.info({ newAlertCount: alerts.length }, "document expiry alert job: done");
    } catch (err) {
      logger.error({ err }, "document expiry alert job failed");
    }
  });
};

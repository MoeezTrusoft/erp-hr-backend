import cron from "node-cron";
import prisma from "../lib/prisma.js";
import { generateDocumentExpiryAlerts } from "./documentExpiryAlert.service.js";


export const startReviewReminderScheduler = () => {
  // Performance review reminders: daily at 9 AM
  cron.schedule("0 9 * * *", async () => {
    console.log("🔔 Running daily performance review reminder job...");

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
        console.error("❌ Reminder error:", err.message);
      }
    }

    console.log("🎯 Performance reminder job completed!");
  });

  // Document expiry alerts: daily at 8 AM
  cron.schedule("0 8 * * *", async () => {
    try {
      const alerts = await generateDocumentExpiryAlerts({ daysBefore: [30, 14, 7] });
      console.log(`📄 Document expiry alert job completed. New alerts: ${alerts.length}`);
    } catch (err) {
      console.error("❌ Document expiry alert job error:", err.message);
    }
  });
};

import cron from "node-cron";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// 🕒 Runs every day at 9 AM
export const startReviewReminderScheduler = () => {
  cron.schedule("0 9 * * *", async () => {
    console.log("🔔 Running daily performance review reminder job...");

    const pendingReviews = await prisma.performanceReview.findMany({
      where: {
        status: { in: ["PENDING", "IN_PROGRESS"] },
      },
      include: {
        employee: true,
        reviewer: true,
        cycle: true,
      },
    });

    for (const review of pendingReviews) {
      try {
        // Avoid sending duplicate reminders for the same review in the same day
        const alreadySent = await prisma.reviewReminder.findFirst({
          where: {
            reviewId: review.id,
            sentToId: review.employeeId,
            sentAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)), // today
            },
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

        console.log(`✅ Reminder sent to employee ${review.employeeId}`);
      } catch (err) {
        console.error("❌ Reminder error:", err.message);
      }
    }

    console.log("🎯 Reminder job completed!");
  });
};

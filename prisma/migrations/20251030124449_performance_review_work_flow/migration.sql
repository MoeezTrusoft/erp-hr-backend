-- CreateEnum
CREATE TYPE "ReminderType" AS ENUM ('PENDING_REVIEW', 'LATE_SUBMISSION', 'FEEDBACK_REQUEST');

-- CreateEnum
CREATE TYPE "ReviewType" AS ENUM ('SELF', 'MANAGER', 'PEER', 'HR');

-- AlterTable
ALTER TABLE "ReviewFeedback" ADD COLUMN     "feedbackById" INTEGER;

-- CreateTable
CREATE TABLE "ReviewReminder" (
    "id" SERIAL NOT NULL,
    "reviewId" INTEGER NOT NULL,
    "sentToId" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "ReminderType" NOT NULL DEFAULT 'PENDING_REVIEW',

    CONSTRAINT "ReviewReminder_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ReviewFeedback" ADD CONSTRAINT "ReviewFeedback_feedbackById_fkey" FOREIGN KEY ("feedbackById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReminder" ADD CONSTRAINT "ReviewReminder_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PerformanceReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReminder" ADD CONSTRAINT "ReviewReminder_sentToId_fkey" FOREIGN KEY ("sentToId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

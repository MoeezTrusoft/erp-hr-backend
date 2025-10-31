-- DropForeignKey
ALTER TABLE "RatingAdjustment" DROP CONSTRAINT "RatingAdjustment_reviewId_fkey";

-- AlterTable
ALTER TABLE "RatingAdjustment" ALTER COLUMN "reviewId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "RatingAdjustment" ADD CONSTRAINT "RatingAdjustment_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PerformanceReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

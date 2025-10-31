-- CreateEnum
CREATE TYPE "CalibrationStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED');

-- AlterTable
ALTER TABLE "PerformanceReview" ADD COLUMN     "calibrationSessionId" INTEGER,
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CalibrationSession" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "cycleId" INTEGER,
    "started_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "status" "CalibrationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalibrationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatingAdjustment" (
    "id" SERIAL NOT NULL,
    "reviewId" INTEGER NOT NULL,
    "calibrationSessionId" INTEGER,
    "old_rating" DOUBLE PRECISION NOT NULL,
    "new_rating" DOUBLE PRECISION NOT NULL,
    "justification" TEXT,
    "calibrated_by_employee_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RatingAdjustment_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_calibrationSessionId_fkey" FOREIGN KEY ("calibrationSessionId") REFERENCES "CalibrationSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationSession" ADD CONSTRAINT "CalibrationSession_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "PerformanceCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingAdjustment" ADD CONSTRAINT "RatingAdjustment_calibrationSessionId_fkey" FOREIGN KEY ("calibrationSessionId") REFERENCES "CalibrationSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingAdjustment" ADD CONSTRAINT "RatingAdjustment_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PerformanceReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingAdjustment" ADD CONSTRAINT "RatingAdjustment_calibrated_by_employee_id_fkey" FOREIGN KEY ("calibrated_by_employee_id") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

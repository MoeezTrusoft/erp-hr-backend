-- DropForeignKey
ALTER TABLE "PerformanceReview" DROP CONSTRAINT "PerformanceReview_employeeId_fkey";

-- AlterTable
ALTER TABLE "PerformanceReview" ALTER COLUMN "employeeId" DROP NOT NULL,
ALTER COLUMN "period_start" DROP NOT NULL,
ALTER COLUMN "period_end" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

/*
  Warnings:

  - You are about to drop the column `createdByID` on the `Employee` table. All the data in the column will be lost.
  - You are about to drop the column `mediaId` on the `Employee` table. All the data in the column will be lost.
  - You are about to drop the column `updatedByID` on the `Employee` table. All the data in the column will be lost.
  - You are about to drop the column `updatedById` on the `Goal` table. All the data in the column will be lost.
  - You are about to drop the column `createdById` on the `GoalAlignment` table. All the data in the column will be lost.
  - You are about to drop the column `approvedById` on the `GoalProgress` table. All the data in the column will be lost.
  - You are about to drop the column `createdById` on the `JobPosting` table. All the data in the column will be lost.
  - You are about to drop the column `createdById` on the `PerformanceCycle` table. All the data in the column will be lost.
  - You are about to drop the column `updatedById` on the `PerformanceCycle` table. All the data in the column will be lost.
  - You are about to drop the column `createdById` on the `PerformanceReview` table. All the data in the column will be lost.
  - You are about to drop the column `submittedById` on the `PerformanceReview` table. All the data in the column will be lost.
  - You are about to drop the column `updatedById` on the `PerformanceReview` table. All the data in the column will be lost.
  - You are about to drop the column `createdById` on the `PerformanceTemplate` table. All the data in the column will be lost.
  - You are about to drop the column `updatedById` on the `PerformanceTemplate` table. All the data in the column will be lost.
  - You are about to drop the column `updatedById` on the `Position` table. All the data in the column will be lost.
  - You are about to drop the column `createdById` on the `ReviewFeedback` table. All the data in the column will be lost.
  - You are about to drop the column `updatedById` on the `ReviewFeedback` table. All the data in the column will be lost.
  - Made the column `created_by` on table `GoalProgress` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_createdByID_fkey";

-- DropForeignKey
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_updatedByID_fkey";

-- DropForeignKey
ALTER TABLE "Goal" DROP CONSTRAINT "Goal_updatedById_fkey";

-- DropForeignKey
ALTER TABLE "GoalAlignment" DROP CONSTRAINT "GoalAlignment_createdById_fkey";

-- DropForeignKey
ALTER TABLE "GoalProgress" DROP CONSTRAINT "GoalProgress_approvedById_fkey";

-- DropForeignKey
ALTER TABLE "GoalProgress" DROP CONSTRAINT "GoalProgress_created_by_fkey";

-- DropForeignKey
ALTER TABLE "JobPosting" DROP CONSTRAINT "JobPosting_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PerformanceCycle" DROP CONSTRAINT "PerformanceCycle_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PerformanceCycle" DROP CONSTRAINT "PerformanceCycle_updatedById_fkey";

-- DropForeignKey
ALTER TABLE "PerformanceReview" DROP CONSTRAINT "PerformanceReview_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PerformanceReview" DROP CONSTRAINT "PerformanceReview_submittedById_fkey";

-- DropForeignKey
ALTER TABLE "PerformanceReview" DROP CONSTRAINT "PerformanceReview_updatedById_fkey";

-- DropForeignKey
ALTER TABLE "PerformanceTemplate" DROP CONSTRAINT "PerformanceTemplate_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PerformanceTemplate" DROP CONSTRAINT "PerformanceTemplate_updatedById_fkey";

-- DropForeignKey
ALTER TABLE "Position" DROP CONSTRAINT "Position_updatedById_fkey";

-- DropForeignKey
ALTER TABLE "ReviewFeedback" DROP CONSTRAINT "ReviewFeedback_createdById_fkey";

-- DropForeignKey
ALTER TABLE "ReviewFeedback" DROP CONSTRAINT "ReviewFeedback_updatedById_fkey";

-- AlterTable
ALTER TABLE "Employee" DROP COLUMN "createdByID",
DROP COLUMN "mediaId",
DROP COLUMN "updatedByID";

-- AlterTable
ALTER TABLE "Goal" DROP COLUMN "updatedById";

-- AlterTable
ALTER TABLE "GoalAlignment" DROP COLUMN "createdById";

-- AlterTable
ALTER TABLE "GoalProgress" DROP COLUMN "approvedById",
ALTER COLUMN "created_by" SET NOT NULL;

-- AlterTable
ALTER TABLE "JobPosting" DROP COLUMN "createdById";

-- AlterTable
ALTER TABLE "PerformanceCycle" DROP COLUMN "createdById",
DROP COLUMN "updatedById";

-- AlterTable
ALTER TABLE "PerformanceReview" DROP COLUMN "createdById",
DROP COLUMN "submittedById",
DROP COLUMN "updatedById";

-- AlterTable
ALTER TABLE "PerformanceTemplate" DROP COLUMN "createdById",
DROP COLUMN "updatedById";

-- AlterTable
ALTER TABLE "Position" DROP COLUMN "updatedById";

-- AlterTable
ALTER TABLE "ReviewFeedback" DROP COLUMN "createdById",
DROP COLUMN "updatedById";

-- CreateTable
CREATE TABLE "Tag" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "tenantId" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" SERIAL NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "source" TEXT,
    "resumeUrl" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "tenantId" INTEGER,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateTag" (
    "id" SERIAL NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,

    CONSTRAINT "CandidateTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" SERIAL NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "jobRequisitionId" INTEGER NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'applied',
    "status" TEXT NOT NULL DEFAULT 'open',
    "tenantId" INTEGER,
    "createdById" INTEGER,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceMetric" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tenantId" INTEGER,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PerformanceMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReviewItem" (
    "id" SERIAL NOT NULL,
    "reviewId" INTEGER NOT NULL,
    "metricId" INTEGER NOT NULL,
    "rating" DOUBLE PRECISION,
    "comment" TEXT,

    CONSTRAINT "PerformanceReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tag_tenantId_name_key" ON "Tag"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_email_key" ON "Candidate"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateTag_candidateId_tagId_key" ON "CandidateTag"("candidateId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_candidateId_jobRequisitionId_key" ON "Application"("candidateId", "jobRequisitionId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceReviewItem_reviewId_metricId_key" ON "PerformanceReviewItem"("reviewId", "metricId");

-- AddForeignKey
ALTER TABLE "GoalProgress" ADD CONSTRAINT "GoalProgress_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateTag" ADD CONSTRAINT "CandidateTag_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateTag" ADD CONSTRAINT "CandidateTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_jobRequisitionId_fkey" FOREIGN KEY ("jobRequisitionId") REFERENCES "JobRequisition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewItem" ADD CONSTRAINT "PerformanceReviewItem_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PerformanceReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewItem" ADD CONSTRAINT "PerformanceReviewItem_metricId_fkey" FOREIGN KEY ("metricId") REFERENCES "PerformanceMetric"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

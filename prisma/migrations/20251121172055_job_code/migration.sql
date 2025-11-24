/*
  Warnings:

  - A unique constraint covering the columns `[jobCode]` on the table `Position` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "jobCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Position_jobCode_key" ON "Position"("jobCode");

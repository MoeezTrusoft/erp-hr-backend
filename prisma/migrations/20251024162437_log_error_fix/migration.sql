-- AlterTable
ALTER TABLE "Log" ADD COLUMN     "employeeId" INTEGER;

-- AddForeignKey
ALTER TABLE "Log" ADD CONSTRAINT "Log_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

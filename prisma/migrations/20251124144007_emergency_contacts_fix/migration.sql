-- AlterTable
ALTER TABLE "EmergencyContacts" ALTER COLUMN "phone" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "nationality" TEXT,
ADD COLUMN     "nationality_id_no" TEXT,
ALTER COLUMN "work_phone" SET DATA TYPE TEXT;

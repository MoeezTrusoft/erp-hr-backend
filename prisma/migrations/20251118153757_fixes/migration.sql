-- DropForeignKey
ALTER TABLE "Position" DROP CONSTRAINT "Position_createdById_fkey";

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "additional_fields" JSONB,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "createdById" INTEGER,
ADD COLUMN     "current_address" TEXT,
ADD COLUMN     "date_of_birth" TIMESTAMP(3),
ADD COLUMN     "email" TEXT,
ADD COLUMN     "employee_code" VARCHAR(50),
ADD COLUMN     "employee_name" TEXT,
ADD COLUMN     "employee_type" TEXT,
ADD COLUMN     "employement_status" TEXT,
ADD COLUMN     "joining_date" TIMESTAMP(3),
ADD COLUMN     "marital_status" TEXT,
ADD COLUMN     "middle_name" TEXT,
ADD COLUMN     "nationality_id" INTEGER,
ADD COLUMN     "nationality_id_type" TEXT,
ADD COLUMN     "permenant_address" TEXT,
ADD COLUMN     "personal_contact" INTEGER,
ADD COLUMN     "photo_url" TEXT,
ADD COLUMN     "postal_code" TEXT,
ADD COLUMN     "preferred_name" TEXT,
ADD COLUMN     "probation_end_date" TIMESTAMP(3),
ADD COLUMN     "province" TEXT,
ADD COLUMN     "remarks" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "tenant_id" INTEGER,
ADD COLUMN     "updatedById" INTEGER,
ADD COLUMN     "work_email" TEXT,
ADD COLUMN     "work_phone" INTEGER,
ALTER COLUMN "hire_date" DROP NOT NULL,
ALTER COLUMN "job_title" DROP NOT NULL,
ALTER COLUMN "status" DROP NOT NULL;

-- CreateTable
CREATE TABLE "EmergencyContacts" (
    "id" SERIAL NOT NULL,
    "Contact_name" TEXT,
    "relationship" TEXT,
    "phone" INTEGER,
    "email" TEXT,
    "employee_Id" INTEGER,

    CONSTRAINT "EmergencyContacts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "EmergencyContacts" ADD CONSTRAINT "EmergencyContacts_employee_Id_fkey" FOREIGN KEY ("employee_Id") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

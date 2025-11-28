-- CreateTable
CREATE TABLE "EmployeeMedia" (
    "id" SERIAL NOT NULL,
    "title" TEXT,
    "category" TEXT,
    "version" TEXT,
    "visibility" BOOLEAN NOT NULL DEFAULT true,
    "effective_date" TEXT,
    "expiry_date" TEXT,
    "notes" TEXT,
    "employee_id" INTEGER,
    "media_id" INTEGER,

    CONSTRAINT "EmployeeMedia_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "EmployeeMedia" ADD CONSTRAINT "EmployeeMedia_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

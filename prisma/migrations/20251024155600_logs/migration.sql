-- CreateTable
CREATE TABLE "Log" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "actionById" INTEGER,
    "notes" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Log_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Log" ADD CONSTRAINT "Log_actionById_fkey" FOREIGN KEY ("actionById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

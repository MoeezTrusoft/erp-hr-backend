-- CreateTable
CREATE TABLE "DashboardLayout" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "dashboardType" TEXT NOT NULL DEFAULT 'workforce',
    "layout" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardLayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DashboardLayout_dashboardType_key" ON "DashboardLayout"("dashboardType");

-- AddForeignKey
ALTER TABLE "DashboardLayout" ADD CONSTRAINT "DashboardLayout_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

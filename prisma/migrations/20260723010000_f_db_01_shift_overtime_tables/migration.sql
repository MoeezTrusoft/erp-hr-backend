-- F-DB-01 / F-DB-02 — create the shift and overtime tables before the fleet
-- RLS migration first references them. This is intentionally non-idempotent:
-- an unexpected pre-existing object must fail rather than silently skip drift.
--
-- The current Prisma models use scalar employee/template/approver identifiers
-- without relations, so this migration does not invent foreign keys that would
-- diverge from schema.prisma. All tenant columns are nullable UUIDs, matching
-- the RBAC Company.uuid tenant identity available at this point in the chain.

CREATE TABLE "shift_templates" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "fromTime" TEXT NOT NULL,
    "toTime" TEXT NOT NULL,
    "shiftType" TEXT NOT NULL DEFAULT 'morning',
    "workMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" UUID,

    CONSTRAINT "shift_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shift_assignments" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "shiftType" TEXT NOT NULL DEFAULT 'morning',
    "workMode" TEXT NOT NULL DEFAULT 'onsite',
    "status" TEXT NOT NULL DEFAULT 'on_shift',
    "fromTime" TEXT,
    "toTime" TEXT,
    "overtimeHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "templateId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" UUID,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shift_swap_requests" (
    "id" SERIAL NOT NULL,
    "requesterId" INTEGER NOT NULL,
    "targetId" INTEGER,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3),
    "shiftType" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approverId" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" UUID,

    CONSTRAINT "shift_swap_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "overtime_requests" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "project" TEXT,
    "reason" TEXT,
    "fromTime" TEXT,
    "toTime" TEXT,
    "approverId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" UUID,

    CONSTRAINT "overtime_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shift_templates_tenantId_idx" ON "shift_templates"("tenantId");
CREATE INDEX "shift_assignments_employeeId_date_idx" ON "shift_assignments"("employeeId", "date");
CREATE INDEX "shift_assignments_tenantId_idx" ON "shift_assignments"("tenantId");
CREATE INDEX "shift_swap_requests_tenantId_idx" ON "shift_swap_requests"("tenantId");
CREATE INDEX "overtime_requests_employeeId_idx" ON "overtime_requests"("employeeId");
CREATE INDEX "overtime_requests_tenantId_idx" ON "overtime_requests"("tenantId");

-- Profile tabs — additive backing for equity / training score / recognition.
-- All additive & nullable; the new table is independent → safe on prod erp-hr.

-- Job & Comp tab: equity component (C4-encrypted at rest; column type stays TEXT).
ALTER TABLE "employment_terms" ADD COLUMN "equity" TEXT;

-- Training tab: assessment score 0-100 (averaged over completed enrollments).
ALTER TABLE "TrainingEnrollment" ADD COLUMN "score" INTEGER;

-- Performance tab: recognition / awards / kudos.
CREATE TABLE "recognitions" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "givenById" INTEGER,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" UUID,

    CONSTRAINT "recognitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recognitions_employeeId_idx" ON "recognitions"("employeeId");
CREATE INDEX "recognitions_tenantId_idx" ON "recognitions"("tenantId");

ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

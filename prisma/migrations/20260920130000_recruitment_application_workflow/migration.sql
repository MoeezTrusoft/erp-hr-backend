-- Recruitment workflow foundation: explicit disposition reasons and immutable stage history.
ALTER TABLE "Application"
  ADD COLUMN "dispositionReason" TEXT,
  ADD COLUMN "holdReason" TEXT,
  ADD COLUMN "withdrawnReason" TEXT;

CREATE TABLE "application_stage_history" (
  "id" SERIAL NOT NULL,
  "applicationId" INTEGER NOT NULL,
  "tenantId" UUID NOT NULL,
  "fromStage" TEXT NOT NULL,
  "toStage" TEXT NOT NULL,
  "reason" TEXT,
  "actorId" INTEGER,
  "source" TEXT NOT NULL DEFAULT 'application',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "application_stage_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "application_stage_history_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "application_stage_history_tenantId_idx"
  ON "application_stage_history"("tenantId");
CREATE INDEX "application_stage_history_applicationId_createdAt_idx"
  ON "application_stage_history"("applicationId", "createdAt");

-- Preserve a baseline for existing tenant-scoped applications. Legacy tenantless
-- rows are intentionally excluded; they must be reconciled before interactive
-- workflow enforcement is enabled for those records.
INSERT INTO "application_stage_history"
  ("applicationId", "tenantId", "fromStage", "toStage", "reason", "source")
SELECT "id", "tenantId", "stage", "stage", 'baseline', 'migration'
FROM "Application"
WHERE "tenantId" IS NOT NULL;

ALTER TABLE "Application" ADD COLUMN "fitScoreCheckedAt" TIMESTAMP(3), ADD COLUMN "fitScoreError" TEXT, ADD COLUMN "questionSnapshot" JSONB;
CREATE INDEX application_fit_queue_idx ON "Application" ("tenantId", "fitScoreCheckedAt", id) WHERE stage NOT IN ('hired','rejected','withdrawn');

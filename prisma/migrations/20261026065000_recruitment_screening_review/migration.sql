ALTER TABLE application_screenings ADD COLUMN "recordKind" TEXT NOT NULL DEFAULT 'DECISION' CHECK ("recordKind" IN ('DECISION','REVIEW')), ADD COLUMN "templateSnapshot" JSONB;
CREATE INDEX application_screenings_latest_decision_idx ON application_screenings("tenantId","applicationId","reviewedAt" DESC,id DESC) WHERE "recordKind"='DECISION';

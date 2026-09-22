-- FR-07 residue — numeric screening scorecards: the template-computed overall
-- and the template that produced it. Additive + nullable: a free-form screening
-- (no template resolved) keeps storing criteria only, and every existing row
-- reads exactly as before.
ALTER TABLE "application_screenings" ADD COLUMN "scoreOverall" DOUBLE PRECISION;
ALTER TABLE "application_screenings" ADD COLUMN "templateId" INTEGER;

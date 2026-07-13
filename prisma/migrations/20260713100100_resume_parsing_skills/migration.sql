-- AI resume parsing — additive nullable columns + new CandidateSkill table.
-- All additive/nullable; the new table is independent, so this is a safe,
-- non-breaking change on the prod erp-hr DB (prod migrations are gated).

-- EmployeeSkill: AI ratings (score 0-100 + level label + provenance).
ALTER TABLE "employee_skills" ADD COLUMN "score" INTEGER;
ALTER TABLE "employee_skills" ADD COLUMN "level" TEXT;
ALTER TABLE "employee_skills" ADD COLUMN "source" TEXT;

-- Candidate: raw parsed-resume JSON (skills/competencies/certifications + meta).
ALTER TABLE "Candidate" ADD COLUMN "parsedResume" JSONB;

-- Pre-hire candidate skills/competencies (self-contained; not linked to Skill catalog).
CREATE TABLE "candidate_skills" (
    "id" SERIAL NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT DEFAULT 'skill',
    "score" INTEGER,
    "level" TEXT,
    "source" TEXT DEFAULT 'ai-resume',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" UUID,

    CONSTRAINT "candidate_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "candidate_skills_candidateId_name_key" ON "candidate_skills"("candidateId", "name");
CREATE INDEX "candidate_skills_candidateId_idx" ON "candidate_skills"("candidateId");
CREATE INDEX "candidate_skills_tenantId_idx" ON "candidate_skills"("tenantId");

ALTER TABLE "candidate_skills" ADD CONSTRAINT "candidate_skills_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- F-DB-02 — schema replay exposed this additional pre-existing chain gap after
-- F-DB-01's four shift/overtime tables were restored. The fleet RLS migration
-- references onboarding_sessions, but no earlier migration creates it.
--
-- This DDL exactly matches the current OnboardingSession model. The checklist
-- relation cascades because a session cannot outlive its owning checklist;
-- assigneeId remains an unconstrained optional scalar as declared by Prisma.
-- No existence guards: drift must fail visibly rather than be silently skipped.

CREATE TABLE "onboarding_sessions" (
    "id" SERIAL NOT NULL,
    "checklistId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "sessionDate" TIMESTAMP(3),
    "fromTime" TEXT,
    "toTime" TEXT,
    "sessionType" TEXT,
    "location" TEXT,
    "assigneeId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" UUID,

    CONSTRAINT "onboarding_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "onboarding_sessions_checklistId_idx" ON "onboarding_sessions"("checklistId");
CREATE INDEX "onboarding_sessions_tenantId_idx" ON "onboarding_sessions"("tenantId");

ALTER TABLE "onboarding_sessions"
    ADD CONSTRAINT "onboarding_sessions_checklistId_fkey"
    FOREIGN KEY ("checklistId") REFERENCES "onboarding_checklists"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

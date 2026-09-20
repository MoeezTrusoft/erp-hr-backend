-- Phase 9 — durable, idempotent accepted-offer → employee/onboarding handoff.
CREATE TABLE "offer_handoffs" (
  "id" SERIAL NOT NULL,
  "offerId" INTEGER NOT NULL,
  "tenantId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "employeeId" INTEGER,
  "checklistId" INTEGER,
  "lastStep" TEXT,
  "lastError" TEXT,
  "completedAt" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "offer_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offer_handoffs_offerId_key" UNIQUE ("offerId"),
  CONSTRAINT "offer_handoffs_offerId_fkey"
    FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "offer_handoffs_tenantId_idx" ON "offer_handoffs"("tenantId");
CREATE INDEX "offer_handoffs_tenantId_status_idx" ON "offer_handoffs"("tenantId", "status");

CREATE TABLE "offer_handoff_attempts" (
  "id" SERIAL NOT NULL,
  "handoffId" INTEGER NOT NULL,
  "tenantId" UUID NOT NULL,
  "step" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "offer_handoff_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offer_handoff_attempts_handoffId_fkey"
    FOREIGN KEY ("handoffId") REFERENCES "offer_handoffs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "offer_handoff_attempts_tenantId_idx" ON "offer_handoff_attempts"("tenantId");
CREATE INDEX "offer_handoff_attempts_handoffId_created_at_idx"
  ON "offer_handoff_attempts"("handoffId", "created_at");

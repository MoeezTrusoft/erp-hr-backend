-- Phase 6 / decision record §4.4 — the INTERVIEW PACKET.
--
-- The matrix's "only if in the interview packet" cells (portfolio, general
-- application documents) need a real persistence point: a document reaches an
-- assigned interviewer's view BECAUSE a row exists here, not because the viewer
-- happens to be assigned to an interview. lib/documentAccess.js is the single
-- decision for every audience × document-class cell, and only classes the
-- matrix permits may be packeted — screening notes and budget/approval
-- documents can never reach an interviewer through this table, whoever asks.
--
-- mediaId is a DAM asset id without a local FK (same as requisition_attachments):
-- the DAM is a shared service plane, not a local table.

CREATE TABLE "interview_packet_items" (
    "id"         SERIAL PRIMARY KEY,
    "interviewId" INTEGER NOT NULL,
    "mediaId"    INTEGER NOT NULL,
    "docClass"   TEXT NOT NULL,
    "label"      TEXT,
    "addedById"  INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId"   UUID
);

ALTER TABLE "interview_packet_items"
    ADD CONSTRAINT "interview_packet_items_interviewId_fkey"
    FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reads: the packet per interview (stable order), tenant-scoped listings.
CREATE INDEX IF NOT EXISTS "interview_packet_items_interviewId_idx"
    ON "interview_packet_items" ("interviewId");
CREATE INDEX IF NOT EXISTS "interview_packet_items_tenantId_idx"
    ON "interview_packet_items" ("tenantId");

-- One packet entry per document per interview; re-adding refreshes the label.
CREATE UNIQUE INDEX IF NOT EXISTS "interview_packet_items_interviewId_mediaId_key"
    ON "interview_packet_items" ("interviewId", "mediaId");

-- The packetable vocabulary — the intersection of "candidate-facing enough for
-- an interviewer" across the §4.4 matrix. Screening notes, budget/approval and
-- offer documents are deliberately outside it; adding a class is a constraint
-- change plus lib/documentAccess.js, never a silent write.
ALTER TABLE "interview_packet_items" DROP CONSTRAINT IF EXISTS "interview_packet_items_docClass_check";
ALTER TABLE "interview_packet_items" ADD CONSTRAINT "interview_packet_items_docClass_check"
    CHECK ("docClass" IN ('PORTFOLIO', 'GENERAL_APPLICATION_DOC', 'INTERVIEW_BRIEF'));

-- ── F-DB-05 convention: staged NOT VALID backfill + own RLS policy ───────────
-- Nullable-tenantId per the recruitment convention (legacy tenantless rows must
-- stay writable), so this table joins the staged-backfill cohort and carries
-- its own policy in this migration.

ALTER TABLE "interview_packet_items" ADD CONSTRAINT "interview_packet_items_tenant_not_null_staged"
  CHECK ("tenantId" IS NOT NULL) NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON "interview_packet_items" TO hr_app;
ALTER TABLE "interview_packet_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_packet_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "interview_packet_items";
CREATE POLICY tenant_isolation ON "interview_packet_items"
  USING ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on')
  WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting('app.tenant_bypass', true) = 'on');

-- Phase 4 / decision record §2.5 — the application window.
--
-- Eligibility (§2.9) needs three facts on the requisition: when applications
-- stop (closesAt), whether the requisition should close ITSELF when all
-- openings are filled (autoCloseWhenFilled), and when the system — as opposed
-- to a person — was the one that closed it (autoClosedAt). All additive and
-- nullable, so every existing requisition keeps its current behaviour: open
-- until a human closes it, and never auto-closing.

ALTER TABLE "JobRequisition" ADD COLUMN IF NOT EXISTS "closesAt"            TIMESTAMP(3);
ALTER TABLE "JobRequisition" ADD COLUMN IF NOT EXISTS "autoCloseWhenFilled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JobRequisition" ADD COLUMN IF NOT EXISTS "autoClosedAt"        TIMESTAMP(3);

-- The read path the eligibility check and the candidate-facing listing use:
-- "which open windows are closing / have closed" and "what closes soonest".
CREATE INDEX IF NOT EXISTS "JobRequisition_status_closesAt_idx"
    ON "JobRequisition" ("status", "closesAt");

-- A self-closing requisition must remember that it did. autoClosedAt without a
-- flag is drift from a failed rollback; a flag with the timestamp unread is a
-- claim nobody can verify.
ALTER TABLE "JobRequisition" DROP CONSTRAINT IF EXISTS "JobRequisition_autoclose_consistency_check";
ALTER TABLE "JobRequisition" ADD CONSTRAINT "JobRequisition_autoclose_consistency_check"
    CHECK (
        ("autoClosedAt" IS NULL)
        OR
        ("autoClosedAt" IS NOT NULL AND "autoCloseWhenFilled")
    );

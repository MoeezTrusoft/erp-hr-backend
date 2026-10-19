-- Phase 4 / decision record §2.4 + §2.4a — per-CHANNEL publication and close
-- bookkeeping on JobPosting.
--
-- Why: "publish to configured recruitment channels" (FR-01.12) and "postings per
-- channel" are not expressible from a single externalUrl, and withdrawal must
-- "close ALL active postings" with a reason (FR-01.07). Before this, publishing
-- twice simply appended a second indistinguishable active posting.
--
-- Everything here is additive with defaults, so existing rows keep working: the
-- pre-existing shape (externalUrl + isActive + postedAt) is preserved and every
-- existing posting is classified as the built-in CAREER_SITE channel.

-- 1. Per-channel columns.
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "channel"     TEXT NOT NULL DEFAULT 'CAREER_SITE';
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "channelRef"  TEXT;
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "postedById"  INTEGER;
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "closedAt"    TIMESTAMP(3);
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "closeReason" TEXT;
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS "closedById"  INTEGER;

-- 2. Normalize pre-existing duplicates BEFORE the uniqueness rule lands.
-- Historical data can hold several active postings for one requisition (nothing
-- stopped that before). Keeping the earliest and closing the rest is the same
-- outcome the new rule would have produced, and it RECORDS the reason rather than
-- deleting a row, so the closure is auditable instead of silent.
UPDATE "JobPosting" p
   SET "isActive"    = false,
       "closedAt"    = COALESCE(p."closedAt", NOW()),
       "closeReason" = 'SUPERSEDED_BY_CHANNEL_MODEL'
 WHERE p."isActive"
   AND EXISTS (
         SELECT 1
           FROM "JobPosting" q
          WHERE q."requisitionId" = p."requisitionId"
            AND q."channel"       = p."channel"
            AND q."isActive"
            AND q."tenantId" IS NOT DISTINCT FROM p."tenantId"
            AND q."id" < p."id"
       );

-- 3. Backfill the close timestamp on rows that were already inactive. The real
-- close moment was never recorded, so postedAt is used as a CONSERVATIVE FLOOR
-- (a posting cannot close before it was posted). Inventing NOW() would have
-- dated historical closures to the day of this migration.
UPDATE "JobPosting"
   SET "closedAt" = "postedAt"
 WHERE NOT "isActive" AND "closedAt" IS NULL;

-- 4. At most ONE ACTIVE posting per requisition + tenant + channel.
-- Partial (WHERE "isActive") so historical closed rows never collide — a channel
-- may be closed and re-opened any number of times, which is exactly the lifecycle
-- §2.4a describes. COALESCE on the nullable tenant: a plain unique index treats
-- NULLs as distinct, which would have let legacy tenantless rows duplicate freely.
CREATE UNIQUE INDEX IF NOT EXISTS "JobPosting_active_channel_key"
    ON "JobPosting" (
        "requisitionId",
        COALESCE("tenantId", '00000000-0000-0000-0000-000000000000'::uuid),
        "channel"
    )
    WHERE "isActive";

-- 5. The read path the publication screens use (@@index([tenantId, requisitionId,
-- isActive]) in schema.prisma).
CREATE INDEX IF NOT EXISTS "JobPosting_tenantId_requisitionId_isActive_idx"
    ON "JobPosting" ("tenantId", "requisitionId", "isActive");

-- 6. The two failure modes here are a "closed" posting that still accepts
-- applications and a live posting that reads as closed, so the state and its
-- bookkeeping are constrained together rather than trusted to the service alone.
ALTER TABLE "JobPosting" DROP CONSTRAINT IF EXISTS "JobPosting_close_consistency_check";
ALTER TABLE "JobPosting" ADD CONSTRAINT "JobPosting_close_consistency_check"
    CHECK (
        ("isActive" AND "closedAt" IS NULL AND "closeReason" IS NULL)
        OR
        (NOT "isActive" AND "closedAt" IS NOT NULL)
    );

-- 7. The channel and close-reason vocabularies, pinned in the database too.
-- Deliberately a lightweight CHECK rather than a Prisma enum: the channel list is
-- read by the candidate portal, and adding a job board should be a one-line
-- constraint change rather than a type change on a table the public site queries.
-- The reference lists live in src/lib/requisitionPublication.js; keep them in step.
ALTER TABLE "JobPosting" DROP CONSTRAINT IF EXISTS "JobPosting_channel_check";
ALTER TABLE "JobPosting" ADD CONSTRAINT "JobPosting_channel_check"
    CHECK (
        "channel" IN ('CAREER_SITE', 'LINKEDIN', 'INDEED', 'AGENCY', 'REFERRAL', 'OTHER')
    );

ALTER TABLE "JobPosting" DROP CONSTRAINT IF EXISTS "JobPosting_close_reason_check";
ALTER TABLE "JobPosting" ADD CONSTRAINT "JobPosting_close_reason_check"
    CHECK (
        "closeReason" IS NULL
        OR "closeReason" IN (
            'FILLED', 'REQUISITION_CLOSED', 'REQUISITION_WITHDRAWN', 'REPOSTED',
            'EXPIRED', 'SUPERSEDED_BY_CHANNEL_MODEL', 'OTHER'
        )
    );

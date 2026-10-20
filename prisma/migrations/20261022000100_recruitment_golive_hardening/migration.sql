-- Recruitment Phase 6 (go-live hardening).
--   * talent_pool_invitations: the candidate answers through an emailed,
--     single-use link; only a hash of the token is stored, with its expiry,
--     and respondedVia records who answered.
--   * internal_referrals: the coded forfeit reason and note of a FORFEITED
--     bonus live on the row (the codes mirror BONUS_FORFEIT_REASONS in
--     src/lib/internal-mobility.util.js; keep them in step).
-- Additive only; both tables are already FORCE RLS.
-- AlterTable
ALTER TABLE "talent_pool_invitations" ADD COLUMN     "respondedVia" TEXT,
ADD COLUMN     "responseTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "responseTokenHash" TEXT;

-- AlterTable
ALTER TABLE "internal_referrals" ADD COLUMN     "bonusForfeitReason" TEXT,
ADD COLUMN     "bonusNote" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "talent_pool_invitations_responseTokenHash_key" ON "talent_pool_invitations"("responseTokenHash");


-- CHECKs
ALTER TABLE "talent_pool_invitations" ADD CONSTRAINT "talent_pool_invitations_respondedVia_check"
    CHECK ("respondedVia" IS NULL OR "respondedVia" IN ('CANDIDATE_LINK', 'RECRUITER'));
ALTER TABLE "talent_pool_invitations" ADD CONSTRAINT "talent_pool_invitations_response_token_check"
    CHECK (("responseTokenHash" IS NULL) = ("responseTokenExpiresAt" IS NULL));
ALTER TABLE "internal_referrals" ADD CONSTRAINT "internal_referrals_bonusForfeitReason_check"
    CHECK (
        "bonusForfeitReason" IS NULL
        OR "bonusForfeitReason" IN ('HIRE_SEPARATED', 'REFERRER_SEPARATED', 'POLICY_INELIGIBLE', 'DUPLICATE_CLAIM', 'OTHER')
    );
ALTER TABLE "internal_referrals" ADD CONSTRAINT "internal_referrals_bonusNote_length_check"
    CHECK ("bonusNote" IS NULL OR char_length("bonusNote") <= 500);

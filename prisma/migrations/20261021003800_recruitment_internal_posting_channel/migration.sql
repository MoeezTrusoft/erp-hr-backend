-- Recruitment Phase 5 — the INTERNAL publication channel (the employees'
-- internal job board). Self-hosted like CAREER_SITE, never public: the
-- careers portal and the job feeds ignore INTERNAL postings. The reference
-- list lives in src/lib/requisitionPublication.js; keep them in step.
ALTER TABLE "JobPosting" DROP CONSTRAINT IF EXISTS "JobPosting_channel_check";
ALTER TABLE "JobPosting" ADD CONSTRAINT "JobPosting_channel_check"
    CHECK (
        "channel" IN ('CAREER_SITE', 'LINKEDIN', 'INDEED', 'AGENCY', 'REFERRAL', 'OTHER', 'INTERNAL')
    );

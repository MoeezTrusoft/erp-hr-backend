-- HR Course Catalog (LMS) — Course Catalog + Course View + Certifications/Transcripts screens.
--
-- Additive only: new nullable/defaulted columns on TrainingCourse + Certification,
-- and four new tables (course_sections, course_lectures, course_outcomes,
-- course_reviews). No data loss. New tables follow the fleet FORCE-RLS pattern
-- (hr_app grants + DEFAULT hr_current_tenant() create-stamp + tenant_isolation
-- policy), matching 20260723020000_hr_rls_fleet_extend.

-- ── Enum ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "CertificationStatus" AS ENUM ('ACTIVE', 'RENEWAL', 'INACTIVE', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── TrainingCourse (LMS columns) ────────────────────────────────────────────
ALTER TABLE "TrainingCourse"
  ADD COLUMN IF NOT EXISTS "courseCode"        TEXT,
  ADD COLUMN IF NOT EXISTS "subtitle"          TEXT,
  ADD COLUMN IF NOT EXISTS "introVideoMediaId" INTEGER,
  ADD COLUMN IF NOT EXISTS "language"          TEXT,
  ADD COLUMN IF NOT EXISTS "createdById"       INTEGER,
  ADD COLUMN IF NOT EXISTS "tags"              TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "relatedTopics"     TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "requirements"      TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "ratingAvg"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ratingCount"       INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE "TrainingCourse"
    ADD CONSTRAINT "TrainingCourse_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "TrainingCourse_categoryId_idx" ON "TrainingCourse"("categoryId");
CREATE INDEX IF NOT EXISTS "TrainingCourse_courseCode_idx" ON "TrainingCourse"("courseCode");

-- ── Certification (category + status) ───────────────────────────────────────
ALTER TABLE "certifications"
  ADD COLUMN IF NOT EXISTS "category" TEXT,
  ADD COLUMN IF NOT EXISTS "status"   "CertificationStatus" NOT NULL DEFAULT 'ACTIVE';

-- ── course_sections ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "course_sections" (
  "id"        SERIAL PRIMARY KEY,
  "courseId"  INTEGER NOT NULL,
  "title"     TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "tenantId"  UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "course_sections_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "course_sections_tenantId_idx" ON "course_sections"("tenantId");
CREATE INDEX IF NOT EXISTS "course_sections_courseId_idx" ON "course_sections"("courseId");

-- ── course_lectures ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "course_lectures" (
  "id"              SERIAL PRIMARY KEY,
  "sectionId"       INTEGER NOT NULL,
  "title"           TEXT NOT NULL,
  "videoMediaId"    INTEGER,
  "durationSeconds" INTEGER NOT NULL DEFAULT 0,
  "sortOrder"       INTEGER NOT NULL DEFAULT 0,
  "isPreview"       BOOLEAN NOT NULL DEFAULT false,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"        UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "course_lectures_sectionId_fkey"
    FOREIGN KEY ("sectionId") REFERENCES "course_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "course_lectures_tenantId_idx" ON "course_lectures"("tenantId");
CREATE INDEX IF NOT EXISTS "course_lectures_sectionId_idx" ON "course_lectures"("sectionId");

-- ── course_outcomes ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "course_outcomes" (
  "id"          SERIAL PRIMARY KEY,
  "courseId"    INTEGER NOT NULL,
  "title"       TEXT NOT NULL,
  "description" TEXT,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "tenantId"    UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "course_outcomes_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "course_outcomes_tenantId_idx" ON "course_outcomes"("tenantId");
CREATE INDEX IF NOT EXISTS "course_outcomes_courseId_idx" ON "course_outcomes"("courseId");

-- ── course_reviews ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "course_reviews" (
  "id"         SERIAL PRIMARY KEY,
  "courseId"   INTEGER NOT NULL,
  "employeeId" INTEGER,
  "rating"     INTEGER NOT NULL,
  "comment"    TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId"   UUID DEFAULT public.hr_current_tenant(),
  CONSTRAINT "course_reviews_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "course_reviews_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "course_reviews_tenantId_idx" ON "course_reviews"("tenantId");
CREATE INDEX IF NOT EXISTS "course_reviews_courseId_idx" ON "course_reviews"("courseId");

-- ── FORCE ROW LEVEL SECURITY on the 4 new tables ────────────────────────────
-- Same shape as the fleet: hr_app owns + is granted DML, tenantId create-stamped
-- from hr_current_tenant(), policy allows own-tenant rows OR the SYSTEM bypass GUC.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['course_sections','course_lectures','course_outcomes','course_reviews']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hr_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'') '
      'WITH CHECK ("tenantId" = public.hr_current_tenant() OR current_setting(''app.tenant_bypass'', true) = ''on'')',
      t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_app;

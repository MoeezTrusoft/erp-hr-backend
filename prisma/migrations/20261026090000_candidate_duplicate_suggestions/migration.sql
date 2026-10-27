-- Contact matches are suggestions only; the merge workflow requires a human preview.
CREATE FUNCTION public.hr_candidate_duplicate_keys(email TEXT,phone TEXT,resume JSONB)
RETURNS TEXT[] LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
 SELECT COALESCE(array_agg(DISTINCT key ORDER BY key),'{}'::text[]) FROM (
  SELECT 'EMAIL:'||lower(trim(value)) AS key FROM unnest(ARRAY[email,
   CASE WHEN jsonb_typeof(resume->'email')='string' THEN resume->>'email' END,
   CASE WHEN jsonb_typeof(resume#>'{contact,email}')='string' THEN resume#>>'{contact,email}' END]) value
   WHERE trim(value) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  UNION ALL
  SELECT 'PHONE:'||regexp_replace(value,'[^0-9]','','g') FROM unnest(ARRAY[phone,
   CASE WHEN jsonb_typeof(resume->'phone')='string' THEN resume->>'phone' END,
   CASE WHEN jsonb_typeof(resume#>'{contact,phone}')='string' THEN resume#>>'{contact,phone}' END]) value
   WHERE length(regexp_replace(value,'[^0-9]','','g')) BETWEEN 7 AND 15
 ) matches;
$$;
CREATE INDEX candidate_duplicate_contact_keys ON "Candidate" USING gin(public.hr_candidate_duplicate_keys(email,phone,"parsedResume")) WHERE status='active' AND "anonymizedAt" IS NULL;
CREATE TABLE "CandidateDuplicateSuggestion" (
 id UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"leftId" INTEGER NOT NULL,"rightId" INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','DISMISSED','RESOLVED')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),"evidenceHash" TEXT NOT NULL CHECK(length("evidenceHash")=64),
 reasons TEXT[] NOT NULL,"reviewedById" INTEGER,"reviewedAt" TIMESTAMPTZ(3),"reviewReason" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT duplicate_pair_order CHECK("leftId"<"rightId"),
 CONSTRAINT duplicate_left_company FOREIGN KEY("tenantId","leftId") REFERENCES "Candidate"("tenantId",id) ON UPDATE CASCADE ON DELETE CASCADE,
 CONSTRAINT duplicate_right_company FOREIGN KEY("tenantId","rightId") REFERENCES "Candidate"("tenantId",id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX candidate_duplicate_pair ON "CandidateDuplicateSuggestion"("tenantId","leftId","rightId");
CREATE INDEX candidate_duplicate_queue ON "CandidateDuplicateSuggestion"("tenantId",state,"updatedAt");
ALTER TABLE "CandidateDuplicateSuggestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateDuplicateSuggestion" FORCE ROW LEVEL SECURITY;
CREATE POLICY duplicate_company ON "CandidateDuplicateSuggestion" USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
-- Erasure must remove inferred identity links in the same database transaction,
-- including callers outside the recruitment privacy service.
CREATE FUNCTION erase_candidate_duplicate_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."anonymizedAt" IS NOT NULL AND OLD."anonymizedAt" IS NULL THEN
  DELETE FROM "CandidateDuplicateSuggestion" WHERE "tenantId"=NEW."tenantId" AND ("leftId"=NEW.id OR "rightId"=NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_duplicate_erasure AFTER UPDATE OF "anonymizedAt" ON "Candidate" FOR EACH ROW EXECUTE FUNCTION erase_candidate_duplicate_links();

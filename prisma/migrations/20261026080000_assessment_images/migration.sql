CREATE TABLE "CandidateAssessmentImage" (
 id SERIAL PRIMARY KEY,
 "tenantId" uuid NOT NULL,
 "mediaId" text NOT NULL,
 sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 "mimeType" text NOT NULL CHECK ("mimeType" IN ('image/png','image/jpeg','image/gif','image/webp')),
 "fileName" text NOT NULL,
 "byteSize" integer NOT NULL CHECK ("byteSize" BETWEEN 1 AND 2097152),
 "createdById" integer NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CandidateAssessmentImage_tenant_id_key" UNIQUE ("tenantId", id),
 CONSTRAINT "CandidateAssessmentImage_tenant_media_hash_key" UNIQUE ("tenantId", "mediaId", sha256),
 CONSTRAINT "CandidateAssessmentImage_creator_fk" FOREIGN KEY ("createdById") REFERENCES "Employee"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "CandidateTestItemImage" (
 "itemId" integer PRIMARY KEY,
 "tenantId" uuid NOT NULL,
 "imageId" integer NOT NULL,
 CONSTRAINT "CandidateTestItemImage_tenant_item_key" UNIQUE ("tenantId", "itemId"),
 CONSTRAINT "CandidateTestItemImage_item_fk" FOREIGN KEY ("tenantId", "itemId") REFERENCES "CandidateTestItem"("tenantId", id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CandidateTestItemImage_image_fk" FOREIGN KEY ("tenantId", "imageId") REFERENCES "CandidateAssessmentImage"("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE "CandidateAssessmentImage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateAssessmentImage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateAssessmentImage_tenant_policy" ON "CandidateAssessmentImage"
 USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on')
 WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
ALTER TABLE "CandidateTestItemImage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CandidateTestItemImage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CandidateTestItemImage_tenant_policy" ON "CandidateTestItemImage"
 USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on')
 WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
CREATE FUNCTION hr_guard_assessment_image() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN RAISE EXCEPTION 'HR-6006: Image evidence is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assessment_image_immutable BEFORE UPDATE ON "CandidateAssessmentImage" FOR EACH ROW EXECUTE FUNCTION hr_guard_assessment_image();
CREATE FUNCTION hr_guard_item_image() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id integer; target_tenant uuid; item_status text;
BEGIN
 target_id := CASE WHEN TG_OP='DELETE' THEN OLD."itemId" ELSE NEW."itemId" END;
 target_tenant := CASE WHEN TG_OP='DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
 IF TG_OP='UPDATE' AND (NEW."itemId"<>OLD."itemId" OR NEW."tenantId"<>OLD."tenantId") THEN RAISE EXCEPTION 'HR-6006: Image binding identity is immutable'; END IF;
 SELECT status INTO item_status FROM "CandidateTestItem" WHERE id=target_id AND "tenantId"=target_tenant FOR UPDATE;
 IF item_status IS NOT NULL AND item_status<>'DRAFT' THEN RAISE EXCEPTION 'HR-6006: Reviewed item images are immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assessment_item_image_immutable BEFORE INSERT OR UPDATE OR DELETE ON "CandidateTestItemImage" FOR EACH ROW EXECUTE FUNCTION hr_guard_item_image();

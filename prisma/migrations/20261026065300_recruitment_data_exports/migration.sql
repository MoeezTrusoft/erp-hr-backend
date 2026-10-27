ALTER TABLE candidate_data_access_requests ADD COLUMN "exportManifest" JSONB;
-- Existing closed requests remain historical. New access fulfilments need an export.
CREATE OR REPLACE FUNCTION hr_candidate_access_export_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.type='ACCESS' AND NEW.status='FULFILLED' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) AND NEW."exportManifest" IS NULL THEN
  RAISE EXCEPTION 'HR-5702: Generate an access export before fulfilment';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_access_export_guard BEFORE INSERT OR UPDATE ON candidate_data_access_requests FOR EACH ROW EXECUTE FUNCTION hr_candidate_access_export_guard();

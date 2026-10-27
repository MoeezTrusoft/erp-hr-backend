CREATE TABLE offer_letter_versions (
 id uuid PRIMARY KEY,
 "tenantId" uuid NOT NULL,
 "offerId" integer NOT NULL,
 "candidateId" integer NOT NULL,
 version integer NOT NULL CHECK (version > 0),
 "offerRevision" integer NOT NULL,
 "mediaId" integer,
 sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 "createdById" integer NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("tenantId", "offerId", version),
 UNIQUE (id, "tenantId", "offerId")
);
CREATE INDEX offer_letter_versions_candidate ON offer_letter_versions ("tenantId", "candidateId");
CREATE TABLE offer_signature_requests (
 id uuid PRIMARY KEY,
 "tenantId" uuid NOT NULL,
 "offerId" integer NOT NULL,
 "candidateId" integer NOT NULL,
 "letterId" uuid NOT NULL,
 state text NOT NULL DEFAULT 'PREPARE' CHECK (state IN ('PREPARE','CREATE','CREATE_UNKNOWN','AWAITING','SIGNED','DECLINED','CANCEL_PENDING','CANCELLED','ERASE_PENDING','ERASED','FAILED')),
 "identityCipher" text,
 "signingUrlCipher" text,
 "nodeId" integer,
 "providerFileId" integer,
 "providerFileUuid" uuid,
 "signedMediaId" integer,
 "signedSha256" varchar(64),
 "signedAt" timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 "dueAt" timestamptz NOT NULL DEFAULT now(),
 "leaseToken" uuid,
 "leaseUntil" timestamptz,
 "lastError" text,
 "createdAt" timestamptz NOT NULL DEFAULT now(),
 "updatedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("tenantId", "offerId"),
 FOREIGN KEY ("letterId", "tenantId", "offerId") REFERENCES offer_letter_versions (id, "tenantId", "offerId")
);
CREATE INDEX offer_signature_requests_due ON offer_signature_requests ("dueAt", "leaseUntil");
CREATE INDEX offer_signature_requests_candidate ON offer_signature_requests ("tenantId", "candidateId");
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['offer_letter_versions','offer_signature_requests'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId"=public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'') WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting(''app.tenant_bypass'',true)=''on'')',tbl);
 END LOOP;
END $$;
CREATE FUNCTION hr_offer_letter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'mediaId') IS DISTINCT FROM (to_jsonb(OLD)-'mediaId') OR (NEW."mediaId" IS DISTINCT FROM OLD."mediaId" AND NEW."mediaId" IS NOT NULL) THEN
   RAISE EXCEPTION 'Offer letter history is immutable';
  END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM offers WHERE id=NEW."offerId" AND "tenantId"=NEW."tenantId" AND "candidateId"=NEW."candidateId" AND status='DRAFT') THEN
  RAISE EXCEPTION 'Offer letter requires an owned draft offer';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "Employee" WHERE id=NEW."createdById" AND tenant_id=NEW."tenantId") THEN
  RAISE EXCEPTION 'Offer letter author must belong to its tenant';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_offer_letter_guard BEFORE INSERT OR UPDATE ON offer_letter_versions FOR EACH ROW EXECUTE FUNCTION hr_offer_letter_guard();
CREATE FUNCTION hr_offer_signature_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM offers WHERE id=NEW."offerId" AND "tenantId"=NEW."tenantId" AND "candidateId"=NEW."candidateId") THEN
  RAISE EXCEPTION 'Signature request must match its offer';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW."tenantId",NEW."offerId",NEW."candidateId",NEW."letterId") IS DISTINCT FROM (OLD.id,OLD."tenantId",OLD."offerId",OLD."candidateId",OLD."letterId") THEN
  RAISE EXCEPTION 'Signature request identity is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_offer_signature_guard BEFORE INSERT OR UPDATE ON offer_signature_requests FOR EACH ROW EXECUTE FUNCTION hr_offer_signature_guard();
CREATE FUNCTION hr_offer_signature_erase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."anonymizedAt" IS NULL AND NEW."anonymizedAt" IS NOT NULL THEN
  UPDATE offer_signature_requests SET state='ERASE_PENDING',"dueAt"=now(),"signingUrlCipher"=NULL,"updatedAt"=now()
  WHERE "tenantId"=NEW."tenantId" AND "candidateId"=NEW.id AND state<>'ERASED';
  UPDATE offer_letter_versions SET "mediaId"=NULL WHERE "tenantId"=NEW."tenantId" AND "candidateId"=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_offer_signature_erase AFTER UPDATE OF "anonymizedAt" ON "Candidate" FOR EACH ROW EXECUTE FUNCTION hr_offer_signature_erase();

CREATE FUNCTION hr_offer_signature_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('DECLINED','EXPIRED','WITHDRAWN') AND OLD.status IS DISTINCT FROM NEW.status THEN
  UPDATE offer_signature_requests SET state='CANCEL_PENDING',"dueAt"=now(),"signingUrlCipher"=NULL,"updatedAt"=now()
  WHERE "tenantId"=NEW."tenantId" AND "offerId"=NEW.id AND state IN ('PREPARE','CREATE','CREATE_UNKNOWN','AWAITING','FAILED');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_offer_signature_terminal AFTER UPDATE OF status ON offers FOR EACH ROW EXECUTE FUNCTION hr_offer_signature_terminal();

DROP TRIGGER hr_approval_guard ON offers;
CREATE TRIGGER hr_approval_guard BEFORE INSERT OR UPDATE ON offers FOR EACH ROW EXECUTE FUNCTION hr_approval_source_guard('OFFER','status','SENT','','createdById','applicationId,candidateId,jobRequisitionId,salary,currency,startDate,expiryDate,notes,offerType,employmentType,terms,compensation,employeeCategory,offerLetterMediaId');

ALTER TABLE candidate_document_uploads DROP CONSTRAINT candidate_document_upload_purpose;
ALTER TABLE candidate_document_uploads ADD CONSTRAINT candidate_document_upload_purpose CHECK (purpose IN ('RESUME','PORTFOLIO','APPLICATION','OFFER_LETTER','SIGNED_OFFER'));

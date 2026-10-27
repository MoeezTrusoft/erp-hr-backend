-- Invitations carry candidate PII and must never reference another tenant's person or job.
CREATE FUNCTION hr_talent_invitation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."tenantId" IS NULL OR NOT EXISTS(SELECT 1 FROM "Candidate" WHERE id=NEW."candidateId" AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5602: invalid invitation candidate'; END IF;
 IF NEW."jobRequisitionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "JobRequisition" WHERE id=NEW."jobRequisitionId" AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5602: invalid invitation job'; END IF;
 IF NEW."invitedById" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Employee" WHERE id=NEW."invitedById" AND tenant_id=NEW."tenantId") THEN RAISE EXCEPTION 'HR-5602: invalid invitation actor'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW."tenantId",NEW."candidateId",NEW."jobRequisitionId",NEW."invitedById",NEW."invitedAt",NEW."expiresAt") IS DISTINCT FROM (OLD."tenantId",OLD."candidateId",OLD."jobRequisitionId",OLD."invitedById",OLD."invitedAt",OLD."expiresAt") THEN RAISE EXCEPTION 'HR-5602: invitation identity is immutable'; END IF;
  IF NEW.status<>OLD.status AND OLD.status<>'INVITED' THEN RAISE EXCEPTION 'HR-5602: invitation answer is final'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_talent_invitation_guard BEFORE INSERT OR UPDATE ON talent_pool_invitations FOR EACH ROW EXECUTE FUNCTION hr_talent_invitation_guard();
-- NULL job ids represent general invitations and also need a unique open invitation.
CREATE UNIQUE INDEX talent_pool_invitations_open_general_key ON talent_pool_invitations("tenantId","candidateId") WHERE status='INVITED' AND "jobRequisitionId" IS NULL;
GRANT USAGE,SELECT ON SEQUENCE talent_pool_invitations_id_seq TO hr_app;

-- Pending and returned requisitions must have a matching central approval state.
-- Deferred checks see the Approval Centre request written later in the same transaction.
CREATE FUNCTION recruitment_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='PENDING_APPROVAL' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
  IF NOT EXISTS (SELECT 1 FROM "HrApprovalRequest" r WHERE r."tenantId"=NEW."tenantId" AND r.kind='REQUISITION' AND r."sourceRef"=NEW.id::text AND r.stage IN ('LINE_MANAGER','HR','MANAGEMENT')) THEN
   RAISE EXCEPTION 'HR-4201: Submit the requisition through HR Approval Centre';
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND NEW.status='DRAFT' AND OLD.status IS DISTINCT FROM NEW.status AND EXISTS (SELECT 1 FROM "HrApprovalRequest" r WHERE r."tenantId"=NEW."tenantId" AND r.kind='REQUISITION' AND r."sourceRef"=NEW.id::text AND r.stage<>'INITIATOR') THEN
  RAISE EXCEPTION 'HR-4201: Return the requisition through HR Approval Centre';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER recruitment_submission_guard AFTER INSERT OR UPDATE ON "JobRequisition" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION recruitment_submission_guard();

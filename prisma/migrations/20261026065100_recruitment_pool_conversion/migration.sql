ALTER TABLE "Application" ADD COLUMN "talentPoolInvitationId" INTEGER;
CREATE UNIQUE INDEX "Application_talentPoolInvitationId_key" ON "Application"("talentPoolInvitationId");
ALTER TABLE "Application" ADD CONSTRAINT "Application_talentPoolInvitationId_fkey" FOREIGN KEY ("talentPoolInvitationId") REFERENCES talent_pool_invitations(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE FUNCTION hr_application_pool_invitation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."talentPoolInvitationId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM talent_pool_invitations i WHERE i.id=NEW."talentPoolInvitationId" AND i."tenantId"=NEW."tenantId"
   AND i."candidateId"=NEW."candidateId" AND i."jobRequisitionId"=NEW."jobRequisitionId" AND i.status='ACCEPTED'
 ) THEN RAISE EXCEPTION 'HR-5602: invitation does not match this application'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hr_application_pool_invitation_guard BEFORE INSERT OR UPDATE ON "Application" FOR EACH ROW EXECUTE FUNCTION hr_application_pool_invitation_guard();

CREATE TABLE "InterviewSlotOffer" (
 id serial PRIMARY KEY,
 "tenantId" uuid NOT NULL,
 "applicationId" integer NOT NULL,
 "createdById" integer NOT NULL,
 "interviewType" text NOT NULL,
 "durationMinutes" integer NOT NULL CHECK ("durationMinutes" BETWEEN 5 AND 480),
 location text,
 "siteRef" varchar(100),
 panel jsonb NOT NULL CHECK (jsonb_typeof(panel)='array' AND jsonb_array_length(panel) BETWEEN 1 AND 20),
 slots jsonb NOT NULL CHECK (jsonb_typeof(slots)='array' AND jsonb_array_length(slots) BETWEEN 3 AND 5),
 "expiresAt" timestamp(3) NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','BOOKED','WITHDRAWN','EXPIRED')),
 "chosenAt" timestamp(3),
 "interviewId" integer UNIQUE,
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "InterviewSlotOffer_application_fk" FOREIGN KEY ("tenantId","applicationId") REFERENCES "Application"("tenantId",id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "InterviewSlotOffer_interview_fk" FOREIGN KEY ("tenantId","interviewId","applicationId") REFERENCES interviews("tenantId",id,"applicationId") ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT "InterviewSlotOffer_booked_check" CHECK ((status='BOOKED')=("interviewId" IS NOT NULL AND "chosenAt" IS NOT NULL))
);
CREATE INDEX "InterviewSlotOffer_tenant_application" ON "InterviewSlotOffer"("tenantId","applicationId",id);
CREATE UNIQUE INDEX "InterviewSlotOffer_open" ON "InterviewSlotOffer"("tenantId","applicationId") WHERE status='OPEN';
ALTER TABLE "InterviewSlotOffer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InterviewSlotOffer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "InterviewSlotOffer_tenant_policy" ON "InterviewSlotOffer"
 USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on')
 WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');
CREATE FUNCTION hr_interview_slot_offer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status <> 'OPEN' OR ROW(OLD."tenantId",OLD."applicationId",OLD."createdById",OLD."interviewType",OLD."durationMinutes",OLD.location,OLD."siteRef",OLD.panel,OLD.slots,OLD."expiresAt",OLD."createdAt") IS DISTINCT FROM ROW(NEW."tenantId",NEW."applicationId",NEW."createdById",NEW."interviewType",NEW."durationMinutes",NEW.location,NEW."siteRef",NEW.panel,NEW.slots,NEW."expiresAt",NEW."createdAt") THEN
  RAISE EXCEPTION 'Interview slot offers are immutable once issued';
 END IF;
 IF NEW.status='BOOKED' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(OLD.slots) s WHERE s.value::timestamp=NEW."chosenAt") THEN
  RAISE EXCEPTION 'The chosen time must be one of the approved slots';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER interview_slot_offer_guard BEFORE UPDATE ON "InterviewSlotOffer" FOR EACH ROW EXECUTE FUNCTION hr_interview_slot_offer_guard();

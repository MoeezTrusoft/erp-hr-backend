CREATE TABLE "InterviewStaffNotice" (
 id serial PRIMARY KEY,
 "tenantId" uuid NOT NULL,
 "interviewId" integer NOT NULL,
 "recipientUserId" integer NOT NULL CHECK ("recipientUserId">0),
 "scheduledAt" timestamp(3) NOT NULL,
 "scheduleRevision" integer NOT NULL DEFAULT 0,
 kind text NOT NULL CHECK (kind IN ('DAY_BEFORE','ONE_HOUR','FEEDBACK_DUE','FEEDBACK_OVERDUE','DECISION_DUE','NO_SHOW_REVIEW')),
 "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "InterviewStaffNotice_interview_fk" FOREIGN KEY ("tenantId","interviewId") REFERENCES interviews("tenantId",id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InterviewStaffNotice_once" ON "InterviewStaffNotice"("tenantId","interviewId","scheduledAt","scheduleRevision",kind,"recipientUserId");
ALTER TABLE "InterviewStaffNotice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InterviewStaffNotice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "InterviewStaffNotice_tenant_policy" ON "InterviewStaffNotice"
 USING ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on')
 WITH CHECK ("tenantId"=public.hr_current_tenant() OR current_setting('app.tenant_bypass',true)='on');

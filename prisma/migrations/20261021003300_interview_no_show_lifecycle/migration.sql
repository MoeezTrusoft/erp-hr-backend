-- Recruitment Phase 3a — NO_SHOW joins the interview lifecycle vocabulary.
--
-- markNoShow appends a NO_SHOW lifecycle row with reason CANDIDATE_NO_SHOW;
-- the Phase 7 CHECKs (20261021001900) allowed neither, so the write failed and
-- the interview stayed SCHEDULED. CANDIDATE_NO_SHOW is not a cancel or
-- reschedule reason: the service still validates those against its own list.

ALTER TABLE "interview_lifecycle_events" DROP CONSTRAINT IF EXISTS "interview_lifecycle_events_eventtype_check";
ALTER TABLE "interview_lifecycle_events" ADD CONSTRAINT "interview_lifecycle_events_eventtype_check"
    CHECK ("eventType" IN ('CANCELLED', 'RESCHEDULED', 'RESCHEDULE_REQUESTED', 'NO_SHOW'));

ALTER TABLE "interview_lifecycle_events" DROP CONSTRAINT IF EXISTS "interview_lifecycle_events_reasoncode_check";
ALTER TABLE "interview_lifecycle_events" ADD CONSTRAINT "interview_lifecycle_events_reasoncode_check"
    CHECK ("reasonCode" IN ('CANDIDATE_REQUEST', 'INTERVIEWER_CONFLICT', 'BUSINESS_REQUEST',
                            'TECHNICAL_ISSUE', 'LOGISTICS_ISSUE', 'REQUISITION_CLOSED', 'OTHER',
                            'CANDIDATE_NO_SHOW'));

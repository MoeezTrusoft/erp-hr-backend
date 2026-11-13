-- Released packets remain addressable while a successor correction is reviewed.
ALTER TABLE "PerfReview" ADD COLUMN "releasedRevisionId" UUID;
UPDATE "PerfReview" SET "releasedRevisionId"="currentRevisionId", version=version+1 WHERE state IN ('RELEASED','ACKNOWLEDGED');
ALTER TABLE "PerfReview" ADD CONSTRAINT perf_released_revision_same_review
  FOREIGN KEY ("tenantId",id,"releasedRevisionId") REFERENCES "PerfReviewRevision" ("tenantId","reviewId",id);
ALTER TABLE "PerfReview" DROP CONSTRAINT perf_review_state;
ALTER TABLE "PerfReview" ADD CONSTRAINT perf_review_state CHECK (state IN
  ('SELF_OPEN','SELF_SUBMITTED','CORRECTION_OPEN','APPROVAL_PENDING','CALIBRATION_READY','CALIBRATION_PENDING','CALIBRATED','RELEASED','ACKNOWLEDGED'));
CREATE OR REPLACE FUNCTION perf_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE required_action TEXT;
BEGIN
  IF NEW."tenantId"<>OLD."tenantId" OR NEW."participantId"<>OLD."participantId" OR NEW."employeeId"<>OLD."employeeId" OR NEW."cycleId"<>OLD."cycleId" THEN
    RAISE EXCEPTION 'Review attribution cannot be changed' USING ERRCODE='23514';
  END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Review update must increment version' USING ERRCODE='23514'; END IF;
  IF NEW."releasedRevisionId" IS DISTINCT FROM OLD."releasedRevisionId" AND NEW.state<>'RELEASED' THEN
    RAISE EXCEPTION 'Released revision changes only through release signoff' USING ERRCODE='23514';
  END IF;
  IF NEW.state<>OLD.state THEN
    required_action=CASE
      WHEN OLD.state='SELF_OPEN' AND NEW.state='SELF_SUBMITTED' THEN 'SUBMIT_SELF'
      WHEN OLD.state IN ('SELF_OPEN','SELF_SUBMITTED','CORRECTION_OPEN') AND NEW.state IN ('APPROVAL_PENDING','CALIBRATION_READY') THEN 'SUBMIT_MANAGER'
      WHEN OLD.state='APPROVAL_PENDING' AND NEW.state='CALIBRATION_READY' THEN 'APPROVE_SENIOR'
      WHEN OLD.state='CALIBRATION_READY' AND NEW.state='CALIBRATION_PENDING' THEN 'PROPOSE_CALIBRATION'
      WHEN OLD.state='CALIBRATION_PENDING' AND NEW.state='CALIBRATED' THEN 'APPROVE_CALIBRATION'
      WHEN OLD.state='CALIBRATION_READY' AND NEW.state='CALIBRATED' THEN 'CONFIRM_CALIBRATION'
      WHEN OLD.state='CALIBRATED' AND NEW.state='RELEASED' THEN 'RELEASE'
      WHEN OLD.state='RELEASED' AND NEW.state='ACKNOWLEDGED' THEN 'ACKNOWLEDGE'
      WHEN OLD.state IN ('RELEASED','ACKNOWLEDGED') AND NEW.state='CORRECTION_OPEN' THEN 'APPEAL_REVISE'
      WHEN OLD.state IN ('APPROVAL_PENDING','CALIBRATION_READY','CALIBRATION_PENDING') AND NEW.state IN ('SELF_OPEN','SELF_SUBMITTED','CORRECTION_OPEN') THEN 'RETURN'
    END;
    IF required_action IS NULL OR NOT EXISTS (
      SELECT 1 FROM "PerfSignoff" s WHERE s."tenantId"=NEW."tenantId" AND s."reviewId"=NEW.id
        AND s."revisionId" IS NOT DISTINCT FROM OLD."currentRevisionId" AND s.action=required_action AND s."approvedVersion"=OLD.version
        AND CASE WHEN required_action IN ('SUBMIT_SELF','ACKNOWLEDGE') THEN s."actorId"=NEW."employeeId"
                 WHEN required_action='SUBMIT_MANAGER' THEN s."actorId"=NEW."managerId"
                 ELSE s."actorId" NOT IN (NEW."employeeId",NEW."managerId") END
    ) THEN RAISE EXCEPTION 'Valid state transition and attested signoff required' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.state='RELEASED' AND (NEW."releasedRevisionId" IS DISTINCT FROM NEW."currentRevisionId" OR NEW."currentRevisionId" IS NULL OR NEW."releasedAt" IS NULL OR NEW."appealDeadline" IS NULL) THEN
    RAISE EXCEPTION 'Release requires a complete immutable packet and appeal deadline' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
-- Revision ancestry cannot point to another employee's review.
ALTER TABLE "PerfReviewRevision" ADD CONSTRAINT perf_predecessor_same_review
  FOREIGN KEY ("tenantId","reviewId","predecessorId") REFERENCES "PerfReviewRevision" ("tenantId","reviewId",id);
ALTER TABLE "PerfGoal" ADD CONSTRAINT perf_goal_employee_fk FOREIGN KEY ("tenantId","employeeId") REFERENCES "Employee" (tenant_id,id);
ALTER TABLE "PerfCheckin" ADD CONSTRAINT perf_checkin_employee_fk FOREIGN KEY ("tenantId","employeeId") REFERENCES "Employee" (tenant_id,id);
ALTER TABLE "PerfCheckin" ADD CONSTRAINT perf_checkin_manager_fk FOREIGN KEY ("tenantId","managerId") REFERENCES "Employee" (tenant_id,id);
ALTER TABLE "PerfFeedback" ADD CONSTRAINT perf_feedback_employee_fk FOREIGN KEY ("tenantId","employeeId") REFERENCES "Employee" (tenant_id,id);
ALTER TABLE "PerfFeedback" ADD CONSTRAINT perf_feedback_author_fk FOREIGN KEY ("tenantId","authorId") REFERENCES "Employee" (tenant_id,id);

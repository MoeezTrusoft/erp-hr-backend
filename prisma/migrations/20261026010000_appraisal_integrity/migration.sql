-- Cross-tenant and cross-review relationships are independently enforced from RLS.
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_tenant_id_id_unique" ON "Employee" (tenant_id,id);
ALTER TABLE "PerfParticipant" ADD CONSTRAINT "perf_participant_employee_fk" FOREIGN KEY ("tenantId","employeeId") REFERENCES "Employee" (tenant_id,id);
ALTER TABLE "PerfParticipant" ADD CONSTRAINT "perf_participant_manager_fk" FOREIGN KEY ("tenantId","managerId") REFERENCES "Employee" (tenant_id,id);
ALTER TABLE "PerfReview" ADD CONSTRAINT "perf_review_employee_fk" FOREIGN KEY ("tenantId","employeeId") REFERENCES "Employee" (tenant_id,id);
ALTER TABLE "PerfReview" ADD CONSTRAINT "perf_review_manager_fk" FOREIGN KEY ("tenantId","managerId") REFERENCES "Employee" (tenant_id,id);
ALTER TABLE "PerfReviewRevision" ADD CONSTRAINT "perf_revision_review_id_unique" UNIQUE ("tenantId","reviewId",id);
ALTER TABLE "PerfReview" ADD CONSTRAINT "perf_current_revision_same_review" FOREIGN KEY ("tenantId",id,"currentRevisionId") REFERENCES "PerfReviewRevision" ("tenantId","reviewId",id);
ALTER TABLE "PerfSignoff" ADD CONSTRAINT "perf_signoff_same_review" FOREIGN KEY ("tenantId","reviewId","revisionId") REFERENCES "PerfReviewRevision" ("tenantId","reviewId",id);
ALTER TABLE "PerfDecisionCase" ADD CONSTRAINT "perf_decision_same_review" FOREIGN KEY ("tenantId","reviewId","revisionId") REFERENCES "PerfReviewRevision" ("tenantId","reviewId",id);
ALTER TABLE "PerfAppeal" ADD CONSTRAINT "perf_appeal_same_review" FOREIGN KEY ("tenantId","reviewId","revisionId") REFERENCES "PerfReviewRevision" ("tenantId","reviewId",id);
ALTER TABLE "PerfReview" ADD CONSTRAINT "perf_independent_manager" CHECK ("employeeId"<>"managerId");
ALTER TABLE "PerfCycle" ADD CONSTRAINT "perf_cycle_dates" CHECK ("periodStart"<="periodEnd" AND "selfDue"<="managerDue");
ALTER TABLE "PerfReview" ADD CONSTRAINT "perf_review_dates" CHECK ("selfDue"<="managerDue");
ALTER TABLE "PerfReview" ADD CONSTRAINT "perf_review_state" CHECK (state IN ('SELF_OPEN','SELF_SUBMITTED','APPROVAL_PENDING','CALIBRATION_READY','CALIBRATION_PENDING','CALIBRATED','RELEASED','ACKNOWLEDGED'));
ALTER TABLE "PerfResponse" ADD CONSTRAINT "perf_response_role" CHECK (role IN ('SELF','MANAGER'));
CREATE FUNCTION perf_cycle_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status<>'DRAFT' AND (NEW."templateId"<>OLD."templateId" OR NEW.policy<>OLD.policy OR NEW.timezone<>OLD.timezone OR NEW."periodStart"<>OLD."periodStart" OR NEW."periodEnd"<>OLD."periodEnd") THEN
 RAISE EXCEPTION 'Launched cycle policy and attribution are immutable' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER perf_cycle_frozen BEFORE UPDATE ON "PerfCycle" FOR EACH ROW EXECUTE FUNCTION perf_cycle_frozen();
-- Legacy approval is already updated to APPROVED inside the same transaction before its adapter applies the outcome.
CREATE FUNCTION perf_legacy_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND OLD.status='FINALIZED' AND (NEW.comments IS DISTINCT FROM OLD.comments OR NEW.overall_rating IS DISTINCT FROM OLD.overall_rating OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId" OR NEW."cycleId" IS DISTINCT FROM OLD."cycleId" OR NEW.type IS DISTINCT FROM OLD.type OR NEW.status IS DISTINCT FROM OLD.status) THEN
 RAISE EXCEPTION 'Finalized legacy review is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.status='FINALIZED' AND (TG_OP='INSERT' OR OLD.status<>'FINALIZED') AND NOT EXISTS(SELECT 1 FROM "HrApprovalRequest" a WHERE a."tenantId"=NEW."tenantId" AND a.kind='PERFORMANCE' AND a."sourceRef"=NEW.id::text AND a.stage='APPROVED') THEN
 RAISE EXCEPTION 'Approved workflow required for finalization' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER perf_legacy_review_guard BEFORE INSERT OR UPDATE ON "PerformanceReview" FOR EACH ROW EXECUTE FUNCTION perf_legacy_review_guard();

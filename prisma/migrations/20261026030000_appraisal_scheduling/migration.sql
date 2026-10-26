ALTER TABLE "PerfReview" ADD COLUMN "scheduleVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PerfCycle" ADD COLUMN "closingSnapshot" JSONB;
CREATE FUNCTION perf_closing_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD."closingSnapshot" IS NOT NULL AND NEW."closingSnapshot" IS DISTINCT FROM OLD."closingSnapshot" THEN
    RAISE EXCEPTION 'Closing snapshot is immutable; subsequent analytics are restatements' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER perf_closing_snapshot_guard BEFORE UPDATE ON "PerfCycle" FOR EACH ROW EXECUTE FUNCTION perf_closing_snapshot_guard();
CREATE INDEX "PerfReview_due_scan" ON "PerfReview" ("tenantId",state,id);
CREATE INDEX "PerfAudit_aggregate_history" ON "PerfAudit" ("tenantId","aggregateId","createdAt");
CREATE INDEX "PerfResponse_review_role" ON "PerfResponse" ("tenantId","reviewId",role,"responseNo");
